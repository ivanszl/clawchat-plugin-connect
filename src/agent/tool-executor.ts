import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { buildTextMessagePayload } from "../clawchat/message-mapper";
import { EVENT } from "../clawchat/protocol";
import type { ConnectWsClient } from "../clawchat/ws-client";
import type { ActivationCredentials, ChatType } from "../types";
import { type ActiveClawChatTurn, authorizeSendFileTarget } from "./send-file-policy";
import { getConnectTool, validateToolInput } from "./tool-catalog";

const MAX_AVATAR_BYTES = 20 * 1024 * 1024;
/** Owner decision 2026-11-14: one file sent with clawchat_send_file may be at most 100 MiB. */
export const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024;
const DENIED_PATH_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);

export interface ToolExecutorOptions {
  baseUrl: string;
  deviceId: string;
  activation: ActivationCredentials;
  wsClient: ConnectWsClient;
  fetchImpl?: typeof fetch;
  /** Canonical-or-not Workspace roots of this Agent Binding; `clawchat_send_file` is confined to them. */
  workspaceRoots?: () => Promise<readonly string[]>;
  /** ClawChat Turns running now; used to decide whether another chat may be targeted. */
  activeTurns?: () => readonly ActiveClawChatTurn[];
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
    sendFile: async (value) => await sendFile(value, options),
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

async function sendFile(input: Record<string, unknown>, options: ToolExecutorOptions): Promise<unknown> {
  const chatId = String(input.chat_id).trim();
  authorizeSendFileTarget({
    chatId,
    ownerUserId: options.activation.ownerUserId,
    activeTurns: options.activeTurns?.() ?? [],
  });
  const requested = String(input.path);
  if (!isAbsolute(requested)) throw new Error("path must be absolute");
  const roots = (
    await Promise.all(
      (await options.workspaceRoots?.())?.map(async (root) => await realpath(root).catch(() => null)) ?? [],
    )
  ).filter((root): root is string => root !== null);
  if (roots.length === 0) throw new Error("no Workspace is available to send files from");
  // realpath resolves every symlink, so a link inside the Workspace that points outside is rejected below.
  const resolved = await realpath(requested).catch(() => {
    throw new Error("file does not exist");
  });
  if (!roots.some((root) => isWithin(root, resolved))) throw new Error("file is outside the Workspace");
  if (
    resolved.split(sep).some((segment) => DENIED_PATH_SEGMENTS.has(segment)) ||
    /^\.env(\..+)?$/u.test(basename(resolved))
  )
    throw new Error("file is in a credential location and is refused");
  const details = await stat(resolved);
  if (!details.isFile()) throw new Error("path is not a regular file");
  if (details.size === 0) throw new Error("file is empty");
  if (details.size > MAX_SEND_FILE_BYTES) throw new Error("file exceeds 100 MiB");
  const file = Bun.file(resolved);
  const uploaded = await options.wsClient.uploadMedia(file, { filename: basename(resolved) });
  const fragment = input.as_document === true ? { ...uploaded, kind: "file" as const } : uploaded;
  const caption = typeof input.caption === "string" ? input.caption : "";
  const payload = buildTextMessagePayload(caption);
  payload.message.body.fragments.push(fragment);
  const ack = await options.wsClient.sendMessageEnvelope(EVENT.MESSAGE_SEND, chatId, payload, {
    toType: (input.chat_type ?? "direct") as ChatType,
  });
  return { sent: true, messageId: ack.payload.message_id, name: basename(resolved), size: details.size };
}

function isWithin(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
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
