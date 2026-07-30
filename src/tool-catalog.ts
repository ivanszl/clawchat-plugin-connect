import { basename } from "node:path";

export type ToolValueType = "string" | "integer" | "boolean" | "string-array" | "mentions";

export interface ToolProperty {
  type: ToolValueType;
  description: string;
  required?: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  record?: "basename" | "url" | "url-array";
}

export interface ConnectToolDefinition {
  name: string;
  description: string;
  timeoutMs: 30_000 | 120_000;
  properties: Record<string, ToolProperty>;
  execution: "http" | "websocket" | "file-upload";
  handler(input: Record<string, unknown>, context: ToolHandlerContext): Promise<unknown> | unknown;
}

export interface ToolHandlerContext {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  mention(input: Record<string, unknown>): Promise<unknown>;
  react(input: Record<string, unknown>): unknown;
  uploadAvatar(input: Record<string, unknown>): Promise<unknown>;
}

const p = (type: ToolValueType, description: string, extra: Partial<ToolProperty> = {}): ToolProperty => ({
  type,
  description,
  ...extra,
});

const http = (
  method: string,
  path: (input: Record<string, unknown>) => string,
  body?: (input: Record<string, unknown>) => unknown,
): Pick<ConnectToolDefinition, "execution" | "handler"> => ({
  execution: "http",
  handler: async (input, context) => await context.request(method, path(input), body ? body(input) : undefined),
});

const websocket = (operation: "mention" | "react"): Pick<ConnectToolDefinition, "execution" | "handler"> => ({
  execution: "websocket",
  handler: async (input, context) => await context[operation](input),
});

const fileUpload: Pick<ConnectToolDefinition, "execution" | "handler"> = {
  execution: "file-upload",
  handler: async (input, context) => await context.uploadAvatar(input),
};

const id = (input: Record<string, unknown>, key: string): string => encodeURIComponent(String(input[key]));

const query = (values: Record<string, unknown>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};

export const CONNECT_TOOL_CATALOG = [
  {
    name: "clawchat_get_account_profile",
    description: "Get the connected ClawChat account profile.",
    timeoutMs: 30_000,
    properties: {},
    ...http("GET", () => "/v1/users/me"),
  },
  {
    name: "clawchat_update_account_profile",
    description: "Update the connected account nickname, avatar URL, or bio.",
    timeoutMs: 30_000,
    properties: {
      nickname: p("string", "New nickname."),
      avatar_url: p("string", "New avatar URL.", { record: "url" }),
      bio: p("string", "New bio."),
    },
    ...http(
      "PATCH",
      () => "/v1/users/me",
      (input) => input,
    ),
  },
  {
    name: "clawchat_upload_avatar_image",
    description: "Upload an absolute local image path for use as the account avatar.",
    timeoutMs: 120_000,
    properties: {
      filePath: p("string", "Absolute local image path (maximum 20 MiB).", {
        required: true,
        record: "basename",
      }),
    },
    ...fileUpload,
  },
  {
    name: "clawchat_get_user_profile",
    description: "Get a public ClawChat profile by exact user ID.",
    timeoutMs: 30_000,
    properties: {
      userId: p("string", "Exact user ID.", { required: true }),
    },
    ...http("GET", (input) => `/v1/users/${id(input, "userId")}`),
  },
  {
    name: "clawchat_list_account_friends",
    description: "List friends of the connected account.",
    timeoutMs: 30_000,
    properties: {},
    ...http("GET", () => "/v1/friendships"),
  },
  {
    name: "clawchat_send_friend_request",
    description: "Send a friend request to an exact user ID.",
    timeoutMs: 30_000,
    properties: {
      userId: p("string", "Exact user ID.", { required: true }),
      greeting: p("string", "Optional greeting."),
    },
    ...http(
      "POST",
      () => "/v1/friendships",
      (input) => ({
        user_id: input.userId,
        ...(input.greeting != null ? { greeting: input.greeting } : {}),
      }),
    ),
  },
  {
    name: "clawchat_list_friend_requests",
    description: "List incoming or outgoing friend requests.",
    timeoutMs: 30_000,
    properties: {
      direction: p("string", "Request direction.", { enum: ["incoming", "outgoing"] }),
    },
    ...http("GET", (input) => `/v1/friendships/requests/${input.direction ?? "incoming"}`),
  },
  {
    name: "clawchat_accept_friend_request",
    description: "Accept an exact friend request ID.",
    timeoutMs: 30_000,
    properties: {
      requestId: p("integer", "Exact request ID.", { required: true, minimum: 1 }),
    },
    ...http("POST", (input) => `/v1/friendships/requests/${id(input, "requestId")}/accept`),
  },
  {
    name: "clawchat_reject_friend_request",
    description: "Reject an exact friend request ID.",
    timeoutMs: 30_000,
    properties: {
      requestId: p("integer", "Exact request ID.", { required: true, minimum: 1 }),
    },
    ...http("POST", (input) => `/v1/friendships/requests/${id(input, "requestId")}/reject`),
  },
  {
    name: "clawchat_remove_friend",
    description: "Remove an existing friend by exact user ID.",
    timeoutMs: 30_000,
    properties: {
      friendUserId: p("string", "Exact friend user ID.", { required: true }),
    },
    ...http("DELETE", (input) => `/v1/friendships/${id(input, "friendUserId")}`),
  },
  {
    name: "clawchat_search_users",
    description: "Search the ClawChat user directory.",
    timeoutMs: 30_000,
    properties: {
      q: p("string", "Username or nickname query."),
      limit: p("integer", "Maximum results.", { minimum: 1, maximum: 100 }),
    },
    ...http("GET", (input) => `/v1/users/search${query({ q: input.q, limit: input.limit })}`),
  },
  {
    name: "clawchat_leave_group",
    description: "Leave a group by exact conversation ID.",
    timeoutMs: 30_000,
    properties: {
      conversationId: p("string", "Exact group conversation ID.", { required: true }),
    },
    ...http("POST", (input) => `/v1/conversations/${id(input, "conversationId")}/leave`),
  },
  {
    name: "clawchat_mention_message",
    description: "Send a real mention message through the connected ClawChat WebSocket.",
    timeoutMs: 30_000,
    properties: {
      chatId: p("string", "Exact conversation ID.", { required: true }),
      chatType: p("string", "Conversation type.", { enum: ["direct", "group"] }),
      text: p("string", "Message body without visible mention labels."),
      mentions: p("mentions", "One or more exact userId/display pairs.", { required: true }),
      replyToMessageId: p("string", "Optional exact reply target message ID."),
    },
    ...websocket("mention"),
  },
  {
    name: "clawchat_react_message",
    description: "Add or remove a quick emoji reaction on an exact message.",
    timeoutMs: 30_000,
    properties: {
      chatId: p("string", "Exact conversation ID.", { required: true }),
      chatType: p("string", "Conversation type.", { required: true, enum: ["direct", "group"] }),
      emoji: p("string", "Single emoji.", { required: true }),
      targetMessageId: p("string", "Exact target message ID.", { required: true }),
      remove: p("boolean", "Remove the reaction instead of adding it."),
    },
    ...websocket("react"),
  },
  {
    name: "clawchat_list_moments",
    description: "List the visible ClawChat moments feed.",
    timeoutMs: 30_000,
    properties: {
      before: p("integer", "Return IDs below this cursor.", { minimum: 1 }),
      limit: p("integer", "Maximum results.", { minimum: 1, maximum: 100 }),
    },
    ...http("GET", (input) => `/v1/moments${query({ before: input.before, limit: input.limit })}`),
  },
  {
    name: "clawchat_create_moment",
    description: "Create a ClawChat moment with text and/or hosted image URLs.",
    timeoutMs: 30_000,
    properties: {
      text: p("string", "Moment text."),
      images: p("string-array", "Hosted image URLs.", { record: "url-array" }),
    },
    ...http(
      "POST",
      () => "/v1/moments",
      (input) => input,
    ),
  },
  {
    name: "clawchat_delete_moment",
    description: "Delete an exact moment ID.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
    },
    ...http("DELETE", (input) => `/v1/moments/${id(input, "momentId")}`),
  },
  {
    name: "clawchat_toggle_moment_reaction",
    description: "Toggle an emoji reaction on an exact moment.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
      emoji: p("string", "Emoji.", { required: true }),
    },
    ...http(
      "POST",
      (input) => `/v1/moments/${id(input, "momentId")}/reactions`,
      (input) => ({
        emoji: input.emoji,
      }),
    ),
  },
  {
    name: "clawchat_create_moment_comment",
    description: "Create a top-level comment on an exact moment.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
      text: p("string", "Comment text.", { required: true }),
    },
    ...http(
      "POST",
      (input) => `/v1/moments/${id(input, "momentId")}/comments`,
      (input) => ({
        text: input.text,
      }),
    ),
  },
  {
    name: "clawchat_reply_moment_comment",
    description: "Reply to an exact comment on an exact moment.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
      replyToCommentId: p("integer", "Exact comment ID.", { required: true, minimum: 1 }),
      text: p("string", "Reply text.", { required: true }),
    },
    ...http(
      "POST",
      (input) => `/v1/moments/${id(input, "momentId")}/comments`,
      (input) => ({
        text: input.text,
        reply_to_comment_id: input.replyToCommentId,
      }),
    ),
  },
  {
    name: "clawchat_delete_moment_comment",
    description: "Delete an exact comment from an exact moment.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
      commentId: p("integer", "Exact comment ID.", { required: true, minimum: 1 }),
    },
    ...http("DELETE", (input) => `/v1/moments/${id(input, "momentId")}/comments/${id(input, "commentId")}`),
  },
  {
    name: "clawchat_register_app",
    description: "Register a Liveware app in ClawChat after its tunnel is bound.",
    timeoutMs: 30_000,
    properties: {
      name: p("string", "Launcher name.", { required: true }),
      appId: p("string", "Exact Liveware app ID.", { required: true }),
      url: p("string", "Exact public tunnel URL.", { required: true, record: "url" }),
    },
    ...http(
      "POST",
      () => "/v1/agents/me/apps",
      (input) => ({
        name: input.name,
        app_id: input.appId,
        url: input.url,
      }),
    ),
  },
  {
    name: "clawchat_list_apps",
    description: "List Liveware apps registered by this agent.",
    timeoutMs: 30_000,
    properties: {},
    ...http("GET", () => "/v1/agents/me/apps"),
  },
  {
    name: "clawchat_unregister_app",
    description: "Unregister an exact Liveware app ID from ClawChat.",
    timeoutMs: 30_000,
    properties: {
      appId: p("string", "Exact Liveware app ID.", { required: true }),
    },
    ...http("DELETE", (input) => `/v1/agents/me/apps/${id(input, "appId")}`),
  },
] as const satisfies readonly ConnectToolDefinition[];

export type ConnectToolName = (typeof CONNECT_TOOL_CATALOG)[number]["name"];

export function getConnectTool(name: string): ConnectToolDefinition | null {
  return CONNECT_TOOL_CATALOG.find((tool) => tool.name === name) ?? null;
}

export function validateToolInput(tool: ConnectToolDefinition, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be a JSON object");
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in tool.properties)) throw new Error(`unknown input field: ${key}`);
  for (const [key, property] of Object.entries(tool.properties)) {
    const value = record[key];
    if (value == null) {
      if (property.required) throw new Error(`${key} is required`);
      continue;
    }
    if (property.type === "string" && (typeof value !== "string" || !value.trim()))
      throw new Error(`${key} must be a non-empty string`);
    if (property.type === "integer" && !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
    if (property.type === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    if (property.type === "string-array" && (!Array.isArray(value) || value.some((item) => typeof item !== "string")))
      throw new Error(`${key} must be an array of strings`);
    if (property.type === "mentions") validateMentions(value, key);
    if (property.enum && !property.enum.includes(String(value)))
      throw new Error(`${key} must be one of ${property.enum.join(", ")}`);
    if (typeof value === "number" && property.minimum != null && value < property.minimum)
      throw new Error(`${key} must be >= ${property.minimum}`);
    if (typeof value === "number" && property.maximum != null && value > property.maximum)
      throw new Error(`${key} must be <= ${property.maximum}`);
  }
  if (
    tool.name === "clawchat_update_account_profile" &&
    !["nickname", "avatar_url", "bio"].some((key) => record[key] != null)
  )
    throw new Error("at least one of nickname, avatar_url, or bio is required");
  if (tool.name === "clawchat_create_moment" && !record.text && !(Array.isArray(record.images) && record.images.length))
    throw new Error("at least one of text or images is required");
  return record;
}

export function recordToolInput(tool: ConnectToolDefinition, input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const policy = tool.properties[key]?.record;
      if (policy === "basename" && typeof value === "string") return [key, basename(value)];
      if (policy === "url" && typeof value === "string") return [key, recordableUrl(value)];
      if (policy === "url-array" && Array.isArray(value))
        return [key, value.map((item) => (typeof item === "string" ? recordableUrl(item) : item))];
      return [key, value];
    }),
  );
}

function recordableUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function validateMentions(value: unknown, key: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must contain at least one mention`);
  for (const [index, mention] of value.entries()) {
    if (!mention || typeof mention !== "object" || Array.isArray(mention))
      throw new Error(`${key}[${index}] must be an object`);
    const item = mention as Record<string, unknown>;
    if (typeof item.userId !== "string" || !item.userId.trim()) throw new Error(`${key}[${index}].userId is required`);
    if (typeof item.display !== "string" || !item.display.replace(/^@/u, "").trim())
      throw new Error(`${key}[${index}].display is required`);
  }
}

export function toolJsonSchema(tool: ConnectToolDefinition): Record<string, unknown> {
  const required = Object.entries(tool.properties).flatMap(([name, property]) => (property.required ? [name] : []));
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(tool.properties).map(([name, property]) => [name, propertyJsonSchema(property)]),
    ),
    ...(required.length ? { required } : {}),
  };
}

function propertyJsonSchema(property: ToolProperty): Record<string, unknown> {
  if (property.type === "mentions")
    return {
      type: "array",
      minItems: 1,
      description: property.description,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: { type: "string", minLength: 1 },
          display: { type: "string", minLength: 1 },
        },
        required: ["userId", "display"],
      },
    };
  const type = property.type === "string-array" ? "array" : property.type;
  return {
    type,
    description: property.description,
    ...(property.type === "string-array" ? { items: { type: "string" } } : {}),
    ...(property.enum ? { enum: property.enum } : {}),
    ...(property.minimum != null ? { minimum: property.minimum } : {}),
    ...(property.maximum != null ? { maximum: property.maximum } : {}),
  };
}
