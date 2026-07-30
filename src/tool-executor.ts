import { basename, isAbsolute } from "node:path";
import { buildTextMessagePayload } from "./message-mapper";
import { EVENT } from "./protocol";
import { getConnectTool, validateToolInput } from "./tool-catalog";
import type { ActivationCredentials, ChatType } from "./types";
import type { ConnectWsClient } from "./ws-client";

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
  if (toolName === "clawchat_mention_message") return await mention(input, options.wsClient);
  if (toolName === "clawchat_react_message") return react(input, options.wsClient);
  if (toolName === "clawchat_upload_avatar_image") return await uploadAvatar(input, options);
  const request = restRequest(toolName, input);
  return await callClawChat(request.method, request.path, request.body, options);
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
  ws.sendReaction(String(input.chatId), String(input.targetMessageId), String(input.emoji), input.remove === true);
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

function restRequest(
  toolName: string,
  input: Record<string, unknown>,
): { method: string; path: string; body?: unknown } {
  const id = (key: string) => encodeURIComponent(String(input[key]));
  const query = (values: Record<string, unknown>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value != null && value !== "") params.set(key, String(value));
    const text = params.toString();
    return text ? `?${text}` : "";
  };
  switch (toolName) {
    case "clawchat_get_account_profile":
      return { method: "GET", path: "/v1/users/me" };
    case "clawchat_update_account_profile":
      return { method: "PATCH", path: "/v1/users/me", body: input };
    case "clawchat_get_user_profile":
      return { method: "GET", path: `/v1/users/${id("userId")}` };
    case "clawchat_list_account_friends":
      return { method: "GET", path: "/v1/friendships" };
    case "clawchat_send_friend_request":
      return {
        method: "POST",
        path: "/v1/friendships",
        body: { user_id: input.userId, ...(input.greeting != null ? { greeting: input.greeting } : {}) },
      };
    case "clawchat_list_friend_requests":
      return { method: "GET", path: `/v1/friendships/requests/${input.direction ?? "incoming"}` };
    case "clawchat_accept_friend_request":
      return { method: "POST", path: `/v1/friendships/requests/${id("requestId")}/accept` };
    case "clawchat_reject_friend_request":
      return { method: "POST", path: `/v1/friendships/requests/${id("requestId")}/reject` };
    case "clawchat_remove_friend":
      return { method: "DELETE", path: `/v1/friendships/${id("friendUserId")}` };
    case "clawchat_search_users":
      return { method: "GET", path: `/v1/users/search${query({ q: input.q, limit: input.limit })}` };
    case "clawchat_leave_group":
      return { method: "POST", path: `/v1/conversations/${id("conversationId")}/leave` };
    case "clawchat_list_moments":
      return { method: "GET", path: `/v1/moments${query({ before: input.before, limit: input.limit })}` };
    case "clawchat_create_moment":
      return { method: "POST", path: "/v1/moments", body: input };
    case "clawchat_delete_moment":
      return { method: "DELETE", path: `/v1/moments/${id("momentId")}` };
    case "clawchat_toggle_moment_reaction":
      return { method: "POST", path: `/v1/moments/${id("momentId")}/reactions`, body: { emoji: input.emoji } };
    case "clawchat_create_moment_comment":
      return { method: "POST", path: `/v1/moments/${id("momentId")}/comments`, body: { text: input.text } };
    case "clawchat_reply_moment_comment":
      return {
        method: "POST",
        path: `/v1/moments/${id("momentId")}/comments`,
        body: { text: input.text, reply_to_comment_id: input.replyToCommentId },
      };
    case "clawchat_delete_moment_comment":
      return { method: "DELETE", path: `/v1/moments/${id("momentId")}/comments/${id("commentId")}` };
    case "clawchat_register_app":
      return {
        method: "POST",
        path: "/v1/agents/me/apps",
        body: { name: input.name, app_id: input.appId, url: input.url },
      };
    case "clawchat_list_apps":
      return { method: "GET", path: "/v1/agents/me/apps" };
    case "clawchat_unregister_app":
      return { method: "DELETE", path: `/v1/agents/me/apps/${id("appId")}` };
    default:
      throw new Error(`tool ${toolName} has no REST mapping`);
  }
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
    if (Number(envelope.code) !== 0)
      throw new Error(typeof envelope.msg === "string" ? envelope.msg : `ClawChat API code ${envelope.code}`);
    return envelope.data;
  }
  if (!response.ok) throw new Error(`ClawChat ${path} failed with HTTP ${response.status}`);
  return payload;
}
