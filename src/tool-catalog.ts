export type ToolValueType = "string" | "integer" | "boolean" | "string-array" | "mentions";

export interface ToolProperty {
  type: ToolValueType;
  description: string;
  required?: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ConnectToolDefinition {
  name: string;
  description: string;
  timeoutMs: 30_000 | 120_000;
  properties: Record<string, ToolProperty>;
}

const p = (type: ToolValueType, description: string, extra: Partial<ToolProperty> = {}): ToolProperty => ({
  type,
  description,
  ...extra,
});

export const CONNECT_TOOL_CATALOG = [
  {
    name: "clawchat_get_account_profile",
    description: "Get the connected ClawChat account profile.",
    timeoutMs: 30_000,
    properties: {},
  },
  {
    name: "clawchat_update_account_profile",
    description: "Update the connected account nickname, avatar URL, or bio.",
    timeoutMs: 30_000,
    properties: {
      nickname: p("string", "New nickname."),
      avatar_url: p("string", "New avatar URL."),
      bio: p("string", "New bio."),
    },
  },
  {
    name: "clawchat_upload_avatar_image",
    description: "Upload an absolute local image path for use as the account avatar.",
    timeoutMs: 120_000,
    properties: {
      filePath: p("string", "Absolute local image path (maximum 20 MiB).", { required: true }),
    },
  },
  {
    name: "clawchat_get_user_profile",
    description: "Get a public ClawChat profile by exact user ID.",
    timeoutMs: 30_000,
    properties: {
      userId: p("string", "Exact user ID.", { required: true }),
    },
  },
  {
    name: "clawchat_list_account_friends",
    description: "List friends of the connected account.",
    timeoutMs: 30_000,
    properties: {},
  },
  {
    name: "clawchat_send_friend_request",
    description: "Send a friend request to an exact user ID.",
    timeoutMs: 30_000,
    properties: {
      userId: p("string", "Exact user ID.", { required: true }),
      greeting: p("string", "Optional greeting."),
    },
  },
  {
    name: "clawchat_list_friend_requests",
    description: "List incoming or outgoing friend requests.",
    timeoutMs: 30_000,
    properties: {
      direction: p("string", "Request direction.", { enum: ["incoming", "outgoing"] }),
    },
  },
  {
    name: "clawchat_accept_friend_request",
    description: "Accept an exact friend request ID.",
    timeoutMs: 30_000,
    properties: {
      requestId: p("integer", "Exact request ID.", { required: true, minimum: 1 }),
    },
  },
  {
    name: "clawchat_reject_friend_request",
    description: "Reject an exact friend request ID.",
    timeoutMs: 30_000,
    properties: {
      requestId: p("integer", "Exact request ID.", { required: true, minimum: 1 }),
    },
  },
  {
    name: "clawchat_remove_friend",
    description: "Remove an existing friend by exact user ID.",
    timeoutMs: 30_000,
    properties: {
      friendUserId: p("string", "Exact friend user ID.", { required: true }),
    },
  },
  {
    name: "clawchat_search_users",
    description: "Search the ClawChat user directory.",
    timeoutMs: 30_000,
    properties: {
      q: p("string", "Username or nickname query."),
      limit: p("integer", "Maximum results.", { minimum: 1, maximum: 100 }),
    },
  },
  {
    name: "clawchat_leave_group",
    description: "Leave a group by exact conversation ID.",
    timeoutMs: 30_000,
    properties: {
      conversationId: p("string", "Exact group conversation ID.", { required: true }),
    },
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
  },
  {
    name: "clawchat_react_message",
    description: "Add or remove a quick emoji reaction on an exact message.",
    timeoutMs: 30_000,
    properties: {
      chatId: p("string", "Exact conversation ID.", { required: true }),
      emoji: p("string", "Single emoji.", { required: true }),
      targetMessageId: p("string", "Exact target message ID.", { required: true }),
      remove: p("boolean", "Remove the reaction instead of adding it."),
    },
  },
  {
    name: "clawchat_list_moments",
    description: "List the visible ClawChat moments feed.",
    timeoutMs: 30_000,
    properties: {
      before: p("integer", "Return IDs below this cursor.", { minimum: 1 }),
      limit: p("integer", "Maximum results.", { minimum: 1, maximum: 100 }),
    },
  },
  {
    name: "clawchat_create_moment",
    description: "Create a ClawChat moment with text and/or hosted image URLs.",
    timeoutMs: 30_000,
    properties: {
      text: p("string", "Moment text."),
      images: p("string-array", "Hosted image URLs."),
    },
  },
  {
    name: "clawchat_delete_moment",
    description: "Delete an exact moment ID.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
    },
  },
  {
    name: "clawchat_toggle_moment_reaction",
    description: "Toggle an emoji reaction on an exact moment.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
      emoji: p("string", "Emoji.", { required: true }),
    },
  },
  {
    name: "clawchat_create_moment_comment",
    description: "Create a top-level comment on an exact moment.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
      text: p("string", "Comment text.", { required: true }),
    },
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
  },
  {
    name: "clawchat_delete_moment_comment",
    description: "Delete an exact comment from an exact moment.",
    timeoutMs: 30_000,
    properties: {
      momentId: p("integer", "Exact moment ID.", { required: true, minimum: 1 }),
      commentId: p("integer", "Exact comment ID.", { required: true, minimum: 1 }),
    },
  },
  {
    name: "clawchat_register_app",
    description: "Register a Liveware app in ClawChat after its tunnel is bound.",
    timeoutMs: 30_000,
    properties: {
      name: p("string", "Launcher name.", { required: true }),
      appId: p("string", "Exact Liveware app ID.", { required: true }),
      url: p("string", "Exact public tunnel URL.", { required: true }),
    },
  },
  {
    name: "clawchat_list_apps",
    description: "List Liveware apps registered by this agent.",
    timeoutMs: 30_000,
    properties: {},
  },
  {
    name: "clawchat_unregister_app",
    description: "Unregister an exact Liveware app ID from ClawChat.",
    timeoutMs: 30_000,
    properties: {
      appId: p("string", "Exact Liveware app ID.", { required: true }),
    },
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
