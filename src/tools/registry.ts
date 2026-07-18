import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { type ClawChatApiClient, createClawChatApiClient } from "../api-client";
import { inferMimeFromPath } from "../media";
import type { ConnectStateStore } from "../state";
import type { ConnectConfig } from "../types";
import { CLAWCHAT_TOOL_NAMES, type ClawChatToolName, clawchatToolSchemas } from "./schema";

export type ClawChatToolStatus = "ok" | "error";
export interface ClawChatToolResult {
  status: ClawChatToolStatus;
  data?: unknown;
  error?: { kind: string; message: string; meta?: Record<string, unknown> };
}
export interface MentionMessagePort {
  sendMentionMessage(input: {
    chatId: string;
    chatType?: "group" | "direct";
    text: string;
    mentions: Array<{ userId: string; display?: string }>;
    replyToMessageId?: string | null;
  }): Promise<unknown>;
}
export interface MemoryPort {
  search(input: unknown): Promise<unknown>;
  read(input: unknown): Promise<unknown>;
  write(input: unknown): Promise<unknown>;
  edit(input: unknown): Promise<unknown>;
  metadataSync(input: unknown): Promise<unknown>;
  metadataUpdate(input: unknown): Promise<unknown>;
}
export interface ClawChatToolContext {
  agentId: string;
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  api?: ClawChatApiClient;
  chatId?: string | null;
  mentionMessage?: MentionMessagePort;
  memory?: MemoryPort;
}
export interface ClawChatToolDefinition {
  name: ClawChatToolName;
  description: string;
  inputSchema: (typeof clawchatToolSchemas)[ClawChatToolName];
  execute(input: unknown, ctx: ClawChatToolContext): Promise<ClawChatToolResult>;
}

type Handler = (input: Record<string, unknown>, ctx: RequiredApiContext) => Promise<unknown>;
interface RequiredApiContext extends ClawChatToolContext {
  api: ClawChatApiClient;
}

const descriptions: Record<ClawChatToolName, string> = {
  clawchat_get_account_profile: "Read the connected ClawChat account profile.",
  clawchat_get_user_profile: "Read a specific ClawChat user's public profile by concrete userId.",
  clawchat_list_account_friends: "List friends for the connected ClawChat account.",
  clawchat_send_friend_request: "Send a friend request to a concrete ClawChat userId.",
  clawchat_list_friend_requests: "List incoming or outgoing friend requests.",
  clawchat_accept_friend_request: "Accept a concrete incoming friend request id.",
  clawchat_reject_friend_request: "Reject a concrete incoming friend request id.",
  clawchat_remove_friend: "Remove a concrete accepted friend by user id.",
  clawchat_search_users: "Search server-side ClawChat users; not local memory search.",
  clawchat_get_conversation: "Read conversation details by conversation id.",
  clawchat_mention_message: "Send a real mention message into the current or supplied ClawChat conversation.",
  clawchat_list_moments: "List ClawChat moments.",
  clawchat_create_moment: "Create a ClawChat moment.",
  clawchat_delete_moment: "Delete a ClawChat moment by id.",
  clawchat_toggle_moment_reaction: "Toggle a reaction on a ClawChat moment.",
  clawchat_create_moment_comment: "Create a top-level moment comment.",
  clawchat_reply_moment_comment: "Reply to an existing moment comment.",
  clawchat_delete_moment_comment: "Delete a moment comment.",
  clawchat_update_account_profile: "Patch the connected account profile.",
  clawchat_upload_avatar_image:
    "Upload a local avatar image and return the avatar URL; does not update profile by itself.",
  clawchat_memory_search: "Search local ClawChat memory targets before read/write/edit when ids are uncertain.",
  clawchat_memory_read: "Read a known local memory target.",
  clawchat_memory_write: "Write memory for a known owner/user/group target.",
  clawchat_memory_edit: "Edit memory for a known owner/user/group target.",
  clawchat_metadata_sync: "Synchronize local metadata with server metadata for a known target.",
  clawchat_metadata_update: "Patch allowed local metadata fields for a known target.",
};

const LOCAL_ONLY_TOOLS = new Set<ClawChatToolName>([
  "clawchat_mention_message",
  "clawchat_memory_search",
  "clawchat_memory_read",
  "clawchat_memory_write",
  "clawchat_memory_edit",
  "clawchat_metadata_sync",
  "clawchat_metadata_update",
]);
const handlers: Record<ClawChatToolName, Handler> = {
  clawchat_get_account_profile: (_input, ctx) => ctx.api.getMyProfile(),
  clawchat_get_user_profile: (input, ctx) => ctx.api.getUserProfile(string(input.userId)),
  clawchat_list_account_friends: (_input, ctx) => ctx.api.listFriends(),
  clawchat_send_friend_request: (input, ctx) =>
    ctx.api.sendFriendRequest({ userId: string(input.userId), greeting: optionalString(input.greeting) }),
  clawchat_list_friend_requests: (input, ctx) =>
    ctx.api.listFriendRequests({ direction: input.direction === "outgoing" ? "outgoing" : "incoming" }),
  clawchat_accept_friend_request: (input, ctx) => ctx.api.acceptFriendRequest(id(input.requestId)),
  clawchat_reject_friend_request: (input, ctx) => ctx.api.rejectFriendRequest(id(input.requestId)),
  clawchat_remove_friend: (input, ctx) => ctx.api.removeFriend(string(input.friendUserId)),
  clawchat_search_users: (input, ctx) =>
    ctx.api.searchUsers({ q: optionalString(input.q), limit: numberOrUndefined(input.limit) }),
  clawchat_get_conversation: (input, ctx) => ctx.api.getConversation(string(input.conversationId)),
  clawchat_mention_message: async (input, ctx) => {
    if (!ctx.mentionMessage)
      throw toolError("config", "clawchat_mention_message requires an active ClawChat Connect message port");
    return await ctx.mentionMessage.sendMentionMessage({
      chatId:
        optionalString(input.chatId) ??
        ctx.chatId ??
        fail("chatId is required outside an active ClawChat conversation"),
      chatType: input.chatType === "direct" ? "direct" : "group",
      text: optionalString(input.text) ?? "",
      mentions: mentionList(input.mentions),
      replyToMessageId: optionalString(input.replyToMessageId),
    });
  },
  clawchat_list_moments: (input, ctx) =>
    ctx.api.listMoments({ before: numberOrUndefined(input.before), limit: numberOrUndefined(input.limit) }),
  clawchat_create_moment: (input, ctx) => ctx.api.createMoment(input),
  clawchat_delete_moment: (input, ctx) => ctx.api.deleteMoment(id(input.momentId)),
  clawchat_toggle_moment_reaction: (input, ctx) =>
    ctx.api.toggleMomentReaction({ momentId: id(input.momentId), emoji: string(input.emoji) }),
  clawchat_create_moment_comment: (input, ctx) =>
    ctx.api.createMomentComment({ momentId: id(input.momentId), text: string(input.text) }),
  clawchat_reply_moment_comment: (input, ctx) =>
    ctx.api.replyMomentComment({
      momentId: id(input.momentId),
      replyToCommentId: id(input.replyToCommentId),
      text: string(input.text),
    }),
  clawchat_delete_moment_comment: (input, ctx) =>
    ctx.api.deleteMomentComment({ momentId: id(input.momentId), commentId: id(input.commentId) }),
  clawchat_update_account_profile: (input, ctx) => ctx.api.updateMyProfile(normalizeProfilePatch(input)),
  clawchat_upload_avatar_image: async (input, ctx) => {
    const filePath = string(input.filePath);
    if (!isAbsolute(filePath)) throw toolError("validation", "filePath must be absolute");
    return await ctx.api.uploadAvatar({
      buffer: await readFile(filePath),
      filename: basename(filePath),
      mime: inferMimeFromPath(filePath),
    });
  },
  clawchat_memory_search: (input, ctx) => requireMemory(ctx).search(input),
  clawchat_memory_read: (input, ctx) => requireMemory(ctx).read(input),
  clawchat_memory_write: (input, ctx) => requireMemory(ctx).write(input),
  clawchat_memory_edit: (input, ctx) => requireMemory(ctx).edit(input),
  clawchat_metadata_sync: (input, ctx) => requireMemory(ctx).metadataSync(input),
  clawchat_metadata_update: (input, ctx) => requireMemory(ctx).metadataUpdate(input),
};

export const CLAWCHAT_TOOL_DEFINITIONS: ClawChatToolDefinition[] = CLAWCHAT_TOOL_NAMES.map((name) => ({
  name,
  description: descriptions[name],
  inputSchema: clawchatToolSchemas[name],
  execute: (input, ctx) => executeClawChatTool(name, input, ctx),
}));

export async function executeClawChatTool(
  name: ClawChatToolName,
  rawInput: unknown,
  ctx: ClawChatToolContext,
): Promise<ClawChatToolResult> {
  const startedAt = Date.now();
  try {
    const parsed = clawchatToolSchemas[name].parse(rawInput) as Record<string, unknown>;
    const api = ctx.api ?? (LOCAL_ONLY_TOOLS.has(name) ? ({} as ClawChatApiClient) : await apiForContext(ctx));
    const data = await handlers[name](parsed, { ...ctx, api });
    const result = { status: "ok" as const, data };
    await ctx.stateStore
      .recordToolCall({
        agentId: ctx.agentId,
        toolName: name,
        args: parsed,
        result,
        status: "ok",
        startedAt,
        endedAt: Date.now(),
      })
      .catch(() => undefined);
    return result;
  } catch (error) {
    const normalized = normalizeToolError(error);
    await ctx.stateStore
      .recordToolCall({
        agentId: ctx.agentId,
        toolName: name,
        args: rawInput,
        status: "error",
        error: normalized.message,
        startedAt,
        endedAt: Date.now(),
      })
      .catch(() => undefined);
    return { status: "error", error: normalized };
  }
}

async function apiForContext(ctx: ClawChatToolContext): Promise<ClawChatApiClient> {
  const activation = await ctx.stateStore.getActivation(ctx.agentId);
  if (!activation) throw toolError("config", `agent ${ctx.agentId} is not activated`);
  return createClawChatApiClient({
    baseUrl: ctx.config.baseUrl,
    mediaBaseUrl: ctx.config.mediaBaseUrl,
    token: activation.accessToken,
  });
}
function requireMemory(ctx: ClawChatToolContext): MemoryPort {
  if (!ctx.memory) throw toolError("config", "ClawChat memory tools require a configured memory port");
  return ctx.memory;
}
function normalizeProfilePatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch = { ...input };
  if (patch.avatarUrl && !patch.avatar_url) patch.avatar_url = patch.avatarUrl;
  delete patch.avatarUrl;
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];
  if (Object.keys(patch).length === 0) throw toolError("validation", "profile patch must contain at least one field");
  return patch;
}
function mentionList(value: unknown): Array<{ userId: string; display?: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    userId: string((item as Record<string, unknown>).userId),
    display: optionalString((item as Record<string, unknown>).display),
  }));
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw toolError("validation", "expected non-empty string");
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw toolError("validation", "expected positive integer id");
  return String(value);
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function fail(message: string): never {
  throw toolError("validation", message);
}
function toolError(
  kind: string,
  message: string,
  meta?: Record<string, unknown>,
): Error & { kind?: string; meta?: Record<string, unknown> } {
  const error = new Error(message) as Error & { kind?: string; meta?: Record<string, unknown> };
  error.kind = kind;
  error.meta = meta;
  return error;
}
function normalizeToolError(error: unknown): { kind: string; message: string; meta?: Record<string, unknown> } {
  if (error && typeof error === "object" && "message" in error) {
    const record = error as { message?: unknown; kind?: unknown; meta?: unknown };
    return {
      kind: typeof record.kind === "string" ? record.kind : "unknown",
      message: typeof record.message === "string" ? record.message : String(error),
      ...(record.meta && typeof record.meta === "object" ? { meta: record.meta as Record<string, unknown> } : {}),
    };
  }
  return { kind: "unknown", message: String(error) };
}
