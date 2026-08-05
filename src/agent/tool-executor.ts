import { basename, isAbsolute } from "node:path";
import { buildTextMessagePayload } from "../clawchat/message-mapper";
import { EVENT } from "../clawchat/protocol";
import type { ConnectWsClient } from "../clawchat/ws-client";
import type { ActivationCredentials, ChatType } from "../types";
import { getConnectTool, validateToolInput } from "./tool-catalog";

const MAX_AVATAR_BYTES = 20 * 1024 * 1024;

export interface ToolExecutorOptions {
  baseUrl: string;
  deviceId: string;
  activation: ActivationCredentials;
  wsClient: ConnectWsClient;
  fetchImpl?: typeof fetch;
}

export class IndeterminateToolExecutionError extends Error {
  override name = "IndeterminateToolExecutionError";
}

export class ClawChatToolApiError extends Error {
  override name = "ClawChatToolApiError";

  constructor(
    message: string,
    readonly code: number,
    readonly status: number,
    readonly path: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}

export function isIndeterminateToolError(error: unknown): boolean {
  return (
    error instanceof IndeterminateToolExecutionError || (error instanceof Error && error.name === "AckTimeoutError")
  );
}

export async function executeConnectTool(
  toolName: string,
  rawInput: Record<string, unknown>,
  options: ToolExecutorOptions,
): Promise<unknown> {
  const tool = getConnectTool(toolName);
  if (!tool) throw new Error(`unknown ClawChat tool: ${toolName}`);
  const input = validateToolInput(tool, rawInput);
  return await tool.handler(input, {
    request: async (method, path, body) => await callClawChat(method, path, body, options),
    mention: async (value) => await mention(value, options.wsClient),
    react: (value) => react(value, options.wsClient),
    uploadAvatar: async (value) => await uploadAvatar(value, options),
  });
}

async function mention(input: Record<string, unknown>, ws: ConnectWsClient): Promise<unknown> {
  const mentions = (input.mentions as Array<{ userId: string; display: string }>).map((item) => ({
    userId: item.userId.trim(),
    display: item.display.replace(/^@/u, "").trim(),
  }));
  const ack = await ws.sendMessageEnvelope(
    EVENT.MESSAGE_REPLY,
    String(input.chatId),
    buildTextMessagePayload(typeof input.text === "string" ? input.text : "", {
      mentions,
      replyToMessageId: typeof input.replyToMessageId === "string" ? input.replyToMessageId : undefined,
    }),
    { toType: (input.chatType ?? "group") as ChatType },
  );
  return { sent: true, messageId: ack.payload.message_id, mentions: mentions.map((item) => item.userId) };
}

function react(input: Record<string, unknown>, ws: ConnectWsClient): unknown {
  ws.sendReaction(String(input.chatId), String(input.targetMessageId), String(input.emoji), input.remove === true, {
    toType: input.chatType as ChatType,
  });
  return {
    reacted: true,
    targetMessageId: input.targetMessageId,
    emoji: input.emoji,
    removed: input.remove === true,
  };
}

async function uploadAvatar(input: Record<string, unknown>, options: ToolExecutorOptions): Promise<unknown> {
  const filePath = String(input.filePath);
  if (!isAbsolute(filePath)) throw new Error("filePath must be absolute");
  const file = Bun.file(filePath);
  if (!(await file.exists())) throw new Error("avatar file does not exist");
  if (file.size > MAX_AVATAR_BYTES) throw new Error("avatar file exceeds 20 MiB");
  const form = new FormData();
  form.set("file", file, basename(filePath));
  return await callClawChat("POST", "/v1/files/upload-url", form, options);
}

async function callClawChat(
  method: string,
  path: string,
  body: unknown,
  options: ToolExecutorOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const form = body instanceof FormData;
  let response: Response;
  try {
    response = await fetchImpl(`${options.baseUrl.replace(/\/+$/u, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.activation.accessToken}`,
        "x-device-id": options.deviceId,
        ...(!form && body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new IndeterminateToolExecutionError(
      `ClawChat ${path} transport outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`ClawChat ${path} returned invalid JSON (HTTP ${response.status})`);
  }
  if (payload && typeof payload === "object" && "code" in payload) {
    const envelope = payload as { code?: unknown; msg?: unknown; data?: unknown };
    const code = Number(envelope.code);
    if (code !== 0)
      throw new ClawChatToolApiError(
        typeof envelope.msg === "string" ? envelope.msg : `ClawChat API code ${envelope.code}`,
        code,
        response.status,
        path,
        envelope.data,
      );
    return envelope.data;
  }
  if (!response.ok) throw new Error(`ClawChat ${path} failed with HTTP ${response.status}`);
  return payload;
}
