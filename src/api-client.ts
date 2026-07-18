import { type ActivationCredentials, AGENT_TYPE, PLATFORM_ID } from "./types";

export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;
export type FetchLike = typeof fetch;
export type ClawChatApiErrorKind = "validation" | "transport" | "api" | "auth";
export class ClawChatApiError extends Error {
  constructor(
    readonly kind: ClawChatApiErrorKind,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ClawChatApiError";
  }
}
export interface AgentConnectResult {
  access_token?: string;
  refresh_token?: string | null;
  agent?: { id?: string; user_id?: string; owner_id?: string };
  conversation?: { id?: string } | null;
}
export interface MediaUploadResult {
  kind: "image" | "file" | "audio" | "video";
  url: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
}
export interface ClawChatApiClient {
  agentsConnect(params: { code: string; existingUserId?: string | null }): Promise<AgentConnectResult>;
  getMyProfile(): Promise<unknown>;
  getUserProfile(userId: string): Promise<unknown>;
  getAgentDetail(agentId: string): Promise<unknown>;
  updateAgentBehavior(behavior: string): Promise<unknown>;
  patchAgent(agentId: string, patch: unknown): Promise<unknown>;
  getConversation(conversationId: string): Promise<unknown>;
  patchConversation(conversationId: string, patch: unknown): Promise<unknown>;
  listFriends(): Promise<unknown>;
  sendFriendRequest(params: { userId: string; greeting?: string }): Promise<unknown>;
  listFriendRequests(params: { direction: "incoming" | "outgoing" }): Promise<unknown>;
  acceptFriendRequest(requestId: string): Promise<unknown>;
  rejectFriendRequest(requestId: string): Promise<unknown>;
  removeFriend(friendUserId: string): Promise<unknown>;
  searchUsers(params: Record<string, string | number | undefined>): Promise<unknown>;
  listMoments(params: Record<string, string | number | undefined>): Promise<unknown>;
  createMoment(input: unknown): Promise<unknown>;
  deleteMoment(momentId: string): Promise<unknown>;
  toggleMomentReaction(params: { momentId: string; emoji: string }): Promise<unknown>;
  createMomentComment(params: { momentId: string; text: string }): Promise<unknown>;
  replyMomentComment(params: {
    momentId: string;
    commentId?: string;
    replyToCommentId: string;
    text: string;
  }): Promise<unknown>;
  deleteMomentComment(params: { momentId: string; commentId: string }): Promise<unknown>;
  updateMyProfile(patch: unknown): Promise<unknown>;
  uploadMedia(params: { buffer: Buffer; filename: string; mime?: string }): Promise<MediaUploadResult>;
  uploadAvatar(params: { buffer: Buffer; filename: string; mime?: string }): Promise<unknown>;
}

export function createClawChatApiClient(options: {
  baseUrl: string;
  mediaBaseUrl?: string;
  token?: string | null;
  fetchImpl?: FetchLike;
}): ClawChatApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl, "baseUrl");
  const mediaBaseUrl = normalizeBaseUrl(options.mediaBaseUrl ?? options.baseUrl, "mediaBaseUrl");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) };
  }
  async function readEnvelope<T>(response: Response, path: string): Promise<T> {
    if (response.status === 401) throw new ClawChatApiError("auth", "unauthorized", { path });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new ClawChatApiError(
        "transport",
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { path },
      );
    }
    if (parsed && typeof parsed === "object" && "code" in parsed) {
      const record = parsed as Record<string, unknown>;
      const code = typeof record.code === "number" ? record.code : Number(record.code);
      if (code !== 0)
        throw new ClawChatApiError("api", typeof record.msg === "string" ? record.msg : `code=${record.code}`, {
          path,
          code: record.code,
          data: record.data,
        });
      return record.data as T;
    }
    if (!response.ok)
      throw new ClawChatApiError("transport", `HTTP ${response.status}`, {
        path,
        status: response.status,
        body: parsed,
      });
    return parsed as T;
  }
  async function call<T>(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string>; base?: string } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${init.base ?? baseUrl}${path}`, {
        method,
        headers: authHeaders(init.headers),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new ClawChatApiError(
        "transport",
        `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        { path },
      );
    }
    return await readEnvelope<T>(response, path);
  }
  function json(body: unknown): { body: string; headers: Record<string, string> } {
    return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
  }
  function requireId(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new ClawChatApiError("validation", `${label} is required`);
    return trimmed;
  }
  function query(params: Record<string, string | number | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
    const rendered = sp.toString();
    return rendered ? `?${rendered}` : "";
  }
  async function uploadMultipart(
    path: string,
    params: { buffer: Buffer; filename: string; mime?: string },
    targetBaseUrl: string,
  ): Promise<unknown> {
    assertUploadSize(params.buffer.byteLength);
    const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mime ?? "application/octet-stream" });
    const form = new FormData();
    form.set("file", blob, params.filename);
    return await call<unknown>("POST", path, { body: form, base: targetBaseUrl });
  }
  return {
    async agentsConnect(params) {
      const body: Record<string, string> = {
        code: requireId(params.code, "agentsConnect: code"),
        platform: PLATFORM_ID,
        type: AGENT_TYPE,
      };
      if (params.existingUserId?.trim()) body.user_id = params.existingUserId.trim();
      return await call<AgentConnectResult>("POST", "/v1/agents/connect", json(body));
    },
    async getMyProfile() {
      return await call<unknown>("GET", "/v1/users/me");
    },
    async getUserProfile(userId) {
      return await call<unknown>("GET", `/v1/users/${encodeURIComponent(requireId(userId, "userId"))}`);
    },
    async getAgentDetail(agentId) {
      return await call<unknown>("GET", `/v1/agents/${encodeURIComponent(requireId(agentId, "agentId"))}`);
    },
    async updateAgentBehavior(behavior) {
      return await call<unknown>("PATCH", "/v1/agents/me/behavior", json({ behavior }));
    },
    async patchAgent(agentId, patch) {
      return await call<unknown>(
        "PATCH",
        `/v1/agents/${encodeURIComponent(requireId(agentId, "agentId"))}`,
        json(patch),
      );
    },
    async getConversation(conversationId) {
      return await call<unknown>(
        "GET",
        `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}`,
      );
    },
    async patchConversation(conversationId, patch) {
      return await call<unknown>(
        "PATCH",
        `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}`,
        json(patch),
      );
    },
    async listFriends() {
      return await call<unknown>("GET", "/v1/friendships");
    },
    async sendFriendRequest(params) {
      return await call<unknown>(
        "POST",
        "/v1/friendships",
        json({
          user_id: requireId(params.userId, "userId"),
          ...(params.greeting ? { greeting: params.greeting } : {}),
        }),
      );
    },
    async listFriendRequests(params) {
      return await call<unknown>("GET", `/v1/friendships/requests/${params.direction}`);
    },
    async acceptFriendRequest(requestId) {
      return await call<unknown>("POST", `/v1/friendships/requests/${encodeURIComponent(requestId)}/accept`);
    },
    async rejectFriendRequest(requestId) {
      return await call<unknown>("POST", `/v1/friendships/requests/${encodeURIComponent(requestId)}/reject`);
    },
    async removeFriend(friendUserId) {
      return await call<unknown>(
        "DELETE",
        `/v1/friendships/${encodeURIComponent(requireId(friendUserId, "friendUserId"))}`,
      );
    },
    async searchUsers(params) {
      return await call<unknown>("GET", `/v1/users/search${query(params)}`);
    },
    async listMoments(params) {
      return await call<unknown>("GET", `/v1/moments${query(params)}`);
    },
    async createMoment(input) {
      return await call<unknown>("POST", "/v1/moments", json(input));
    },
    async deleteMoment(momentId) {
      return await call<unknown>("DELETE", `/v1/moments/${encodeURIComponent(momentId)}`);
    },
    async toggleMomentReaction(params) {
      return await call<unknown>(
        "POST",
        `/v1/moments/${encodeURIComponent(params.momentId)}/reactions`,
        json({ emoji: params.emoji }),
      );
    },
    async createMomentComment(params) {
      return await call<unknown>(
        "POST",
        `/v1/moments/${encodeURIComponent(params.momentId)}/comments`,
        json({ text: params.text }),
      );
    },
    async replyMomentComment(params) {
      return await call<unknown>(
        "POST",
        `/v1/moments/${encodeURIComponent(params.momentId)}/comments`,
        json({ text: params.text, reply_to_comment_id: params.replyToCommentId }),
      );
    },
    async deleteMomentComment(params) {
      return await call<unknown>(
        "DELETE",
        `/v1/moments/${encodeURIComponent(params.momentId)}/comments/${encodeURIComponent(params.commentId)}`,
      );
    },
    async updateMyProfile(patch) {
      return await call<unknown>("PATCH", "/v1/users/me", json(patch));
    },
    async uploadMedia(params) {
      return parseMediaUpload(await uploadMultipart("/media/upload", params, mediaBaseUrl));
    },
    async uploadAvatar(params) {
      return await uploadMultipart("/v1/files/upload-url", params, baseUrl);
    },
  };
}

export function normalizeActivationResult(localAgentId: string, raw: AgentConnectResult): ActivationCredentials {
  const accessToken = requireTrimmedString(raw.access_token, "access_token");
  const agent = raw.agent ?? {};
  return {
    localAgentId,
    accessToken,
    refreshToken: optionalTrimmedString(raw.refresh_token),
    serverAgentId: optionalTrimmedString(agent.id),
    userId: requireTrimmedString(agent.user_id, "agent.user_id"),
    ownerUserId: requireTrimmedString(agent.owner_id, "agent.owner_id"),
    conversationId: raw.conversation ? optionalTrimmedString(raw.conversation.id) : null,
  };
}
export function assertUploadSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) throw new ClawChatApiError("validation", "media size is invalid");
  if (bytes > MAX_MEDIA_UPLOAD_BYTES)
    throw new ClawChatApiError("validation", `media file too large (${bytes} bytes; max 20MB)`);
}
function parseMediaUpload(value: unknown): MediaUploadResult {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const kind = record.kind;
  if (kind !== "image" && kind !== "file" && kind !== "audio" && kind !== "video")
    throw new ClawChatApiError("api", "invalid media upload response: kind is required");
  const size = typeof record.size === "number" ? record.size : Number.NaN;
  if (!Number.isFinite(size)) throw new ClawChatApiError("api", "invalid media upload response: size is required");
  return {
    kind,
    url: requireTrimmedString(record.url, "media.url"),
    name: requireTrimmedString(record.name, "media.name"),
    mime: requireTrimmedString(record.mime, "media.mime"),
    size,
    ...(typeof record.width === "number" ? { width: record.width } : {}),
    ...(typeof record.height === "number" ? { height: record.height } : {}),
    ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
  };
}
function normalizeBaseUrl(value: string, label: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//iu.test(trimmed))
    throw new ClawChatApiError("validation", `${label} must start with http:// or https://`);
  return trimmed;
}
function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ClawChatApiError("api", `agents/connect response missing required field ${field}`);
  return value.trim();
}
function optionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
