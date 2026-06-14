import * as z from "zod";

export const CLAWCHAT_TOOL_NAMES = [
  "clawchat_get_account_profile",
  "clawchat_get_user_profile",
  "clawchat_list_account_friends",
  "clawchat_send_friend_request",
  "clawchat_list_friend_requests",
  "clawchat_accept_friend_request",
  "clawchat_reject_friend_request",
  "clawchat_remove_friend",
  "clawchat_search_users",
  "clawchat_get_conversation",
  "clawchat_mention_message",
  "clawchat_list_moments",
  "clawchat_create_moment",
  "clawchat_delete_moment",
  "clawchat_toggle_moment_reaction",
  "clawchat_create_moment_comment",
  "clawchat_reply_moment_comment",
  "clawchat_delete_moment_comment",
  "clawchat_update_account_profile",
  "clawchat_upload_avatar_image",
  "clawchat_memory_search",
  "clawchat_memory_read",
  "clawchat_memory_write",
  "clawchat_memory_edit",
  "clawchat_metadata_sync",
  "clawchat_metadata_update",
] as const;

export type ClawChatToolName = typeof CLAWCHAT_TOOL_NAMES[number];
export const ClawChatToolNameSchema = z.enum(CLAWCHAT_TOOL_NAMES);
export type ToolInput<T extends z.ZodTypeAny> = z.infer<T>;

const empty = z.object({}).strict();
const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);
const optionalText = z.string().trim().optional();
const targetType = z.enum(["owner", "user", "group"]);
const positiveInt = (label: string) => z.number().int().positive(`${label} must be a positive integer`);
const metadataPatch = z.object({
  nickname: optionalText,
  avatar_url: optionalText,
  bio: optionalText,
  agent_behavior: optionalText,
  group_title: optionalText,
  group_description: optionalText,
}).strict().refine((value) => Object.keys(value).length > 0, "patch must contain at least one allowed metadata field");

export const clawchatToolSchemas = {
  clawchat_get_account_profile: empty,
  clawchat_get_user_profile: z.object({ userId: nonEmpty("userId") }).strict(),
  clawchat_list_account_friends: empty,
  clawchat_send_friend_request: z.object({ userId: nonEmpty("userId"), greeting: optionalText }).strict(),
  clawchat_list_friend_requests: z.object({ direction: z.enum(["incoming", "outgoing"]).default("incoming") }).strict(),
  clawchat_accept_friend_request: z.object({ requestId: positiveInt("requestId") }).strict(),
  clawchat_reject_friend_request: z.object({ requestId: positiveInt("requestId") }).strict(),
  clawchat_remove_friend: z.object({ friendUserId: nonEmpty("friendUserId") }).strict(),
  clawchat_search_users: z.object({ q: optionalText, limit: z.number().int().positive().max(100).optional() }).strict(),
  clawchat_get_conversation: z.object({ conversationId: nonEmpty("conversationId") }).strict(),
  clawchat_mention_message: z.object({ chatId: nonEmpty("chatId"), chatType: z.enum(["group", "direct"]).optional(), text: optionalText, mentions: z.array(z.object({ userId: nonEmpty("mentions[].userId"), display: optionalText }).strict()).min(1), replyToMessageId: optionalText }).strict(),
  clawchat_list_moments: z.object({ before: z.number().int().positive().optional(), limit: z.number().int().positive().max(100).optional() }).strict(),
  clawchat_create_moment: z.object({ text: optionalText, images: z.array(z.string()).optional() }).strict(),
  clawchat_delete_moment: z.object({ momentId: positiveInt("momentId") }).strict(),
  clawchat_toggle_moment_reaction: z.object({ momentId: positiveInt("momentId"), emoji: nonEmpty("emoji") }).strict(),
  clawchat_create_moment_comment: z.object({ momentId: positiveInt("momentId"), text: nonEmpty("text") }).strict(),
  clawchat_reply_moment_comment: z.object({ momentId: positiveInt("momentId"), replyToCommentId: positiveInt("replyToCommentId"), text: nonEmpty("text") }).strict(),
  clawchat_delete_moment_comment: z.object({ momentId: positiveInt("momentId"), commentId: positiveInt("commentId") }).strict(),
  clawchat_update_account_profile: z.object({ nickname: optionalText, avatar_url: optionalText, bio: optionalText }).strict(),
  clawchat_upload_avatar_image: z.object({ filePath: nonEmpty("filePath") }).strict(),
  clawchat_memory_search: z.object({ query: nonEmpty("query"), targetTypes: z.array(targetType).min(1).optional(), maxResults: z.number().int().positive().max(50).optional() }).strict(),
  clawchat_memory_read: z.object({ targetType, targetId: nonEmpty("targetId"), offset: z.number().int().min(0).optional(), limit: z.number().int().positive().max(100000).optional() }).strict(),
  clawchat_memory_write: z.object({ targetType, targetId: nonEmpty("targetId"), mode: z.enum(["append", "replace"]), content: z.string() }).strict(),
  clawchat_memory_edit: z.object({ targetType, targetId: nonEmpty("targetId"), oldText: nonEmpty("oldText"), newText: z.string() }).strict(),
  clawchat_metadata_sync: z.object({ targetType, targetId: nonEmpty("targetId"), direction: z.enum(["pull", "push"]), fields: z.array(nonEmpty("fields[]")).min(1).optional() }).strict(),
  clawchat_metadata_update: z.object({ targetType, targetId: nonEmpty("targetId"), patch: metadataPatch }).strict(),
} satisfies Record<ClawChatToolName, z.ZodTypeAny>;
