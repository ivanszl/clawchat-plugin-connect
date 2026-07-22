import {
  type Envelope,
  EVENT,
  type Fragment,
  isMaterializedMessagePayload,
  type MessagePayload,
  type NormalizedInboundMessage,
} from "./protocol";

export interface MentionPayloadInput {
  userId: string;
  display?: string;
}
export interface BuildTextMessagePayloadOptions {
  mentions?: MentionPayloadInput[];
  replyToMessageId?: string | null;
  replyPreview?: { id: string; nickName: string; fragments: Fragment[] } | null;
}

export function fragmentsToText(fragments: Fragment[]): string {
  return fragments
    .map((fragment) => {
      const record = fragment as Record<string, unknown>;
      if (fragment.kind === "text") return typeof record.text === "string" ? record.text : "";
      if (fragment.kind === "mention") {
        const display = typeof record.display === "string" ? record.display : "";
        const userId = typeof record.user_id === "string" ? record.user_id : "";
        return display ? `@${display}` : userId ? `@${userId}` : "@unknown";
      }
      return typeof record.name === "string" ? `[${fragment.kind}: ${record.name}]` : `[${fragment.kind}]`;
    })
    .filter(Boolean)
    .join("");
}

export function extractMentionIds(fragments: Fragment[], mentions: unknown[]): string[] {
  const ids = new Set<string>();
  for (const fragment of fragments) {
    const userId = (fragment as Record<string, unknown>).user_id;
    if (fragment.kind === "mention" && typeof userId === "string" && userId) ids.add(userId);
  }
  for (const mention of mentions) {
    if (typeof mention === "string" && mention) ids.add(mention);
    if (mention && typeof mention === "object" && !Array.isArray(mention)) {
      const record = mention as Record<string, unknown>;
      const value = record.user_id ?? record.userId ?? record.id;
      if (typeof value === "string" && value) ids.add(value);
    }
  }
  return Array.from(ids);
}

export function normalizeInboundMessage(envelope: Envelope): NormalizedInboundMessage | null {
  if (envelope.event !== EVENT.MESSAGE_SEND && envelope.event !== EVENT.MESSAGE_REPLY) return null;
  if (!envelope.chat_id || !envelope.chat_type || !envelope.sender || !isMaterializedMessagePayload(envelope.payload))
    return null;
  const payload = envelope.payload as MessagePayload;
  const messageId = typeof payload.message_id === "string" && payload.message_id ? payload.message_id : null;
  if (!messageId) return null;
  const fragments = payload.message.body.fragments;
  return {
    event: envelope.event,
    chatId: envelope.chat_id,
    chatType: envelope.chat_type === "group" ? "group" : "direct",
    messageId,
    traceId: envelope.trace_id,
    sender: envelope.sender,
    emittedAt: envelope.emitted_at,
    text: fragmentsToText(fragments),
    fragments,
    mentions: extractMentionIds(fragments, payload.message.context.mentions),
    replyToMessageId: payload.message.context.reply?.reply_to_msg_id ?? null,
    raw: envelope as Envelope<MessagePayload>,
  };
}

export function buildTextMessagePayload(text: string, options: BuildTextMessagePayloadOptions = {}): MessagePayload {
  const mentionFragments: Fragment[] = (options.mentions ?? []).map((mention) => ({
    kind: "mention",
    user_id: mention.userId,
    ...(mention.display ? { display: mention.display } : {}),
  }));
  const textFragments: Fragment[] = text
    ? [{ kind: "text", text: mentionFragments.length > 0 ? ` ${text}` : text }]
    : [];
  return {
    message_mode: "normal",
    message: {
      body: { fragments: [...mentionFragments, ...textFragments] },
      context: {
        mentions: (options.mentions ?? []).map((mention) => ({
          user_id: mention.userId,
          ...(mention.display ? { display: mention.display } : {}),
        })),
        reply: options.replyToMessageId
          ? {
              reply_to_msg_id: options.replyToMessageId,
              reply_preview: options.replyPreview
                ? {
                    id: options.replyPreview.id,
                    nick_name: options.replyPreview.nickName,
                    fragments: options.replyPreview.fragments,
                  }
                : null,
            }
          : null,
      },
    },
  };
}

export function buildReplyTextMessagePayload(text: string, source: NormalizedInboundMessage): MessagePayload {
  return buildTextMessagePayload(text, {
    replyToMessageId: source.messageId,
    replyPreview: {
      id: source.sender.id,
      nickName: source.sender.nick_name,
      fragments: source.fragments,
    },
  });
}
