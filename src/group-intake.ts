import type { ClawChatApiClient } from "./api-client";
import { isConnectControlMessage, requiresOrderedSessionControl } from "./chat-commands";
import { addressInboundMessage, isMessageAddressedToAgent, normalizeInboundMessage } from "./message-mapper";
import type { Envelope, Fragment, NormalizedInboundMessage } from "./protocol";
import { renderClawChatPrompt } from "./runtime/prompt-renderer";
import { isRuntimeInteractionResponseText } from "./runtime/runtime-interaction-router";
import type { ConnectStateStore, GroupSettingsRecord } from "./state";

export interface GroupIntakeCoordinatorOptions {
  bindingId: string;
  agentUserId: string;
  stateStore: ConnectStateStore;
  api: Pick<ClawChatApiClient, "getMyGroupSettings">;
  dispatch(
    message: NormalizedInboundMessage,
    allowUnaddressedGroup: boolean,
    onTurnAccepted: () => Promise<void>,
  ): Promise<boolean>;
  reject(message: NormalizedInboundMessage, reason: string): Promise<void>;
  writeError(message: string): void;
  clock?: GroupIntakeClock;
}

export interface GroupIntakeClock {
  now(): number;
  setTimer(callback: () => void, delayMilliseconds: number): unknown;
  clearTimer(timer: unknown): void;
}

const SYSTEM_CLOCK: GroupIntakeClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const DEFAULT_GROUP_SETTINGS: Omit<GroupSettingsRecord, "conversationId" | "version"> = {
  muted: false,
  replyMode: "mention",
  batchDelaySeconds: 0,
};
const MAX_BATCH_CHARACTERS = 64_000;
const MAX_BATCH_ATTACHMENTS = 10;
const SETTINGS_REFRESH_GATE_MS = 5_000;

interface PendingGroupBatch {
  messages: NormalizedInboundMessage[];
  idleTimer: unknown;
  maximumTimer: unknown;
  delaySeconds: number;
}

export class GroupIntakeCoordinator {
  private rows = new Map<string, GroupSettingsRecord>();
  private stale = false;
  private settingsEpoch = 0;
  private refreshPromise: Promise<boolean> | null = null;
  private settingsResolution: Promise<boolean> | null = null;
  private initialization: Promise<void> | null = null;
  private readonly batches = new Map<string, PendingGroupBatch>();
  private accepting = true;
  private readonly clock: GroupIntakeClock;

  constructor(private readonly options: GroupIntakeCoordinatorOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.loadPersistedSnapshot();
    }
    await this.initialization;
  }

  refreshInBackground(): void {
    void this.refresh().catch((error) => {
      this.options.writeError(
        `${this.options.bindingId}: group settings refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  async handleNotifySignal(envelope: Envelope): Promise<boolean> {
    const payload = envelope.payload as Record<string, unknown>;
    if (payload.type !== "agent.config.changed") return false;
    const activeRefresh = this.settingsResolution ?? this.refreshPromise;
    this.settingsEpoch += 1;
    await this.initialize();
    this.stale = true;
    await this.options.stateStore.markGroupSettingsSnapshotStale(this.options.bindingId);
    const requiredRefresh = activeRefresh
      ? activeRefresh.catch(() => false).then(async () => await this.refresh())
      : this.refresh();
    const resolution = requiredRefresh.finally(() => {
      if (this.settingsResolution === resolution) this.settingsResolution = null;
    });
    this.settingsResolution = resolution;
    void resolution.catch((error) => {
      this.options.writeError(
        `${this.options.bindingId}: group settings refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    return true;
  }

  async accept(message: NormalizedInboundMessage): Promise<void> {
    if (!this.accepting) throw new Error("group intake coordinator is closing");
    await this.initialize();
    if (this.stale) await this.refreshWithinGate(this.settingsResolution ?? this.refresh());
    const settings = this.effective(message.chatId);
    const mentioned = isMessageAddressedToAgent(message, this.options.agentUserId);
    if (settings.muted || (settings.replyMode === "mention" && !mentioned)) {
      await this.markHandled(message, "policy-discarded");
      return;
    }
    const addressed = addressInboundMessage(message, this.options.agentUserId);
    const commandText = addressed?.message.text ?? "";
    const commandForm = Boolean(addressed && (addressed.acceptsCommands || addressed.malformedLineBreakCommand));
    if (commandForm && (isConnectControlMessage(commandText) || isRuntimeInteractionResponseText(commandText))) {
      if (requiresOrderedSessionControl(commandText)) await this.flush(message.chatId);
      await this.dispatch(message, false);
      return;
    }
    if (settings.replyMode === "all" && settings.batchDelaySeconds > 0) {
      await this.enqueue(addressed?.hasAddressingMention ? addressed.message : message, settings.batchDelaySeconds);
      if (mentioned) await this.flush(message.chatId);
      return;
    }
    if (await this.rejectIfOverCapacity(message)) return;
    if (settings.replyMode === "mention") message = await this.withMentionContext(message);
    await this.dispatch(message, settings.replyMode === "all");
  }

  private async dispatch(
    message: NormalizedInboundMessage,
    allowUnaddressedGroup: boolean,
    sourceMessages: readonly NormalizedInboundMessage[] = [message],
  ): Promise<boolean> {
    let accepted = false;
    const markAccepted = async () => {
      if (accepted) return;
      accepted = true;
      for (const source of sourceMessages) await this.markHandled(source);
    };
    const handledWithoutTurn = await this.options.dispatch(message, allowUnaddressedGroup, markAccepted);
    if (handledWithoutTurn) await markAccepted();
    return accepted;
  }

  async close(): Promise<void> {
    this.accepting = false;
    for (const batch of this.batches.values()) {
      this.clock.clearTimer(batch.idleTimer);
      this.clock.clearTimer(batch.maximumTimer);
    }
    this.batches.clear();
  }

  private async enqueue(message: NormalizedInboundMessage, delaySeconds: number): Promise<void> {
    let batch = this.batches.get(message.chatId);
    if (batch?.messages.some((candidate) => candidate.messageId === message.messageId)) return;
    if (batch && !batchCanAppend(batch.messages, message)) {
      await this.flush(message.chatId);
      batch = undefined;
    }
    if (!batchCanAppend([], message)) {
      await this.options.reject(
        message,
        "ClawChat group message exceeds the 64,000-character or 10-attachment batch limit.",
      );
      await this.markHandled(message, "policy-discarded");
      return;
    }
    if (!batch) {
      batch = {
        messages: [],
        idleTimer: this.clock.setTimer(() => undefined, 0),
        maximumTimer: this.clock.setTimer(() => undefined, 0),
        delaySeconds,
      };
      this.clock.clearTimer(batch.idleTimer);
      this.clock.clearTimer(batch.maximumTimer);
      this.batches.set(message.chatId, batch);
    }
    batch.messages.push(message);
    batch.delaySeconds = delaySeconds;
    this.schedule(batch, message.chatId);
  }

  private async flushSafely(chatId: string): Promise<void> {
    try {
      await this.flush(chatId);
    } catch (error) {
      this.options.writeError(
        `${this.options.bindingId}: group batch dispatch failed for ${chatId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private async flush(chatId: string): Promise<void> {
    const batch = this.batches.get(chatId);
    if (!batch) return;
    if (this.stale) await this.refreshWithinGate(this.settingsResolution ?? this.refresh());
    const settings = this.effective(chatId);
    if (
      settings.muted ||
      (settings.replyMode === "mention" &&
        !batch.messages.some((message) => isMessageAddressedToAgent(message, this.options.agentUserId)))
    ) {
      await this.discard(chatId);
      return;
    }
    this.batches.delete(chatId);
    this.clock.clearTimer(batch.idleTimer);
    this.clock.clearTimer(batch.maximumTimer);
    if (batch.messages.length === 0) return;
    await this.dispatch(coalescedMessage(batch.messages), true, batch.messages);
  }

  private effective(conversationId: string): Omit<GroupSettingsRecord, "conversationId" | "version"> {
    if (this.stale) return DEFAULT_GROUP_SETTINGS;
    return this.rows.get(conversationId) ?? DEFAULT_GROUP_SETTINGS;
  }

  private async loadPersistedSnapshot(): Promise<void> {
    const snapshot = await this.options.stateStore.getGroupSettingsSnapshot(this.options.bindingId);
    this.rows = new Map(snapshot.rows.map((row) => [row.conversationId, row]));
    this.stale = snapshot.stale;
  }

  private async refresh(): Promise<boolean> {
    if (this.refreshPromise) return await this.refreshPromise;
    const epoch = this.settingsEpoch;
    this.refreshPromise = this.refreshOnce(epoch).finally(() => {
      this.refreshPromise = null;
    });
    return await this.refreshPromise;
  }

  private async refreshWithinGate(requiredRefresh: Promise<boolean> = this.refresh()): Promise<boolean> {
    const refresh = requiredRefresh.catch((error) => {
      this.options.writeError(
        `${this.options.bindingId}: group settings refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return false;
    });
    let timeout: unknown;
    try {
      return await Promise.race([
        refresh,
        new Promise<boolean>((resolve) => {
          timeout = this.clock.setTimer(() => resolve(false), SETTINGS_REFRESH_GATE_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) this.clock.clearTimer(timeout);
    }
  }

  private async refreshOnce(epoch: number): Promise<boolean> {
    await this.initialize();
    const result = await this.options.api.getMyGroupSettings();
    if (!result.authoritative) return false;
    if (epoch !== this.settingsEpoch) return false;
    await this.options.stateStore.replaceGroupSettingsSnapshot(this.options.bindingId, result.rows);
    if (epoch !== this.settingsEpoch) {
      await this.options.stateStore.markGroupSettingsSnapshotStale(this.options.bindingId);
      return false;
    }
    this.rows = new Map(result.rows.map((row) => [row.conversationId, row]));
    this.stale = false;
    await this.reconcileBatches();
    return true;
  }

  private schedule(batch: PendingGroupBatch, chatId: string): void {
    this.clock.clearTimer(batch.idleTimer);
    this.clock.clearTimer(batch.maximumTimer);
    const first = batch.messages[0];
    const last = batch.messages.at(-1);
    if (!first || !last) return;
    const now = this.clock.now();
    const idleDeadline = last.emittedAt + batch.delaySeconds * 1_000;
    const maximumDeadline = first.emittedAt + Math.max(30, batch.delaySeconds) * 1_000;
    batch.idleTimer = this.clock.setTimer(() => void this.flushSafely(chatId), Math.max(0, idleDeadline - now));
    batch.maximumTimer = this.clock.setTimer(() => void this.flushSafely(chatId), Math.max(0, maximumDeadline - now));
  }

  private async reconcileBatches(): Promise<void> {
    for (const [chatId, batch] of [...this.batches]) {
      const settings = this.effective(chatId);
      if (settings.muted || settings.replyMode === "mention") {
        if (
          settings.replyMode === "mention" &&
          batch.messages.some((message) => isMessageAddressedToAgent(message, this.options.agentUserId))
        ) {
          await this.flush(chatId);
        } else {
          await this.discard(chatId);
        }
        continue;
      }
      if (settings.batchDelaySeconds === 0) {
        await this.flush(chatId);
        continue;
      }
      batch.delaySeconds = settings.batchDelaySeconds;
      this.schedule(batch, chatId);
    }
  }

  private async discard(chatId: string): Promise<void> {
    const batch = this.batches.get(chatId);
    if (!batch) return;
    this.batches.delete(chatId);
    this.clock.clearTimer(batch.idleTimer);
    this.clock.clearTimer(batch.maximumTimer);
    for (const message of batch.messages) await this.markHandled(message, "policy-discarded");
  }

  private async withMentionContext(message: NormalizedInboundMessage): Promise<NormalizedInboundMessage> {
    const recent = await this.options.stateStore.listRecentGroupContext(
      this.options.bindingId,
      message.chatId,
      message.messageId,
      10,
    );
    const context = recent.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const candidate = normalizeInboundMessage(raw as Envelope);
      if (candidate?.chatType !== "group" || candidate.chatId !== message.chatId) return [];
      return [
        {
          message_id: candidate.messageId,
          sender: {
            user_id: candidate.sender.id,
            display: candidate.sender.nick_name || candidate.sender.id,
          },
          emitted_at: candidate.emittedAt,
          text: candidate.text,
        },
      ];
    });
    let contextual = context.length > 0 ? { ...message, groupMentionContext: context } : message;
    while (contextual.groupMentionContext?.length && renderClawChatPrompt(contextual).length > MAX_BATCH_CHARACTERS) {
      contextual = { ...contextual, groupMentionContext: contextual.groupMentionContext.slice(1) };
    }
    if (contextual.groupMentionContext?.length === 0) {
      const { groupMentionContext: _emptyContext, ...withoutContext } = contextual;
      return withoutContext;
    }
    return contextual;
  }

  private async markHandled(
    message: NormalizedInboundMessage,
    outcome: "runtime" | "policy-discarded" = "runtime",
  ): Promise<void> {
    await this.options.stateStore.markInboundMessageHandled(
      this.options.bindingId,
      message.messageId,
      message.raw,
      outcome,
    );
  }

  private async rejectIfOverCapacity(message: NormalizedInboundMessage): Promise<boolean> {
    if (
      renderClawChatPrompt(message).length <= MAX_BATCH_CHARACTERS &&
      attachmentCount(message.fragments) <= MAX_BATCH_ATTACHMENTS
    ) {
      return false;
    }
    await this.options.reject(
      message,
      "ClawChat group message exceeds the 64,000-character or 10-attachment batch limit.",
    );
    await this.markHandled(message, "policy-discarded");
    return true;
  }
}

function batchCanAppend(messages: readonly NormalizedInboundMessage[], next: NormalizedInboundMessage): boolean {
  const candidates = [...messages, next];
  return (
    renderedBatchCharacters(candidates) <= MAX_BATCH_CHARACTERS &&
    candidates.reduce((count, message) => count + attachmentCount(message.fragments), 0) <= MAX_BATCH_ATTACHMENTS
  );
}

function renderedBatchCharacters(messages: readonly NormalizedInboundMessage[]): number {
  return renderClawChatPrompt(coalescedMessage(messages)).length;
}

function attachmentCount(fragments: readonly Fragment[]): number {
  return fragments.filter((fragment) => ["image", "file", "audio", "video"].includes(fragment.kind)).length;
}

function formatBatchText(messages: readonly NormalizedInboundMessage[]): string {
  return [
    "ClawChat group messages:",
    ...messages.map((message, index) => {
      const sender = escapeBatchField(message.sender.nick_name || message.sender.id);
      const label = `[message ${index + 1}] ${sender}:`;
      const body = message.text || "(empty message)";
      return body.includes("\n") ? `${label}\n${body}` : `${label} ${body}`;
    }),
  ].join("\n");
}

function escapeBatchField(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function coalescedMessage(messages: readonly NormalizedInboundMessage[]): NormalizedInboundMessage {
  const last = messages.at(-1);
  if (!last) throw new Error("cannot dispatch an empty Group Message Batch");
  const fragments = messages.flatMap((message) => message.fragments);
  return {
    ...last,
    text: formatBatchText(messages),
    fragments,
    replyAnchorFragments: last.fragments,
    mentions: [...new Set(messages.flatMap((message) => message.mentions))],
    groupBatch: {
      messages: messages.map(groupBatchSource),
    },
  };
}

function groupBatchSource(message: NormalizedInboundMessage) {
  return {
    message_id: message.messageId,
    sender: {
      user_id: message.sender.id,
      display: message.sender.nick_name || message.sender.id,
    },
    emitted_at: message.emittedAt,
    mentioned_user_ids: message.mentions,
    reply_to_message_id: message.replyToMessageId,
    fragments: message.fragments,
  };
}
