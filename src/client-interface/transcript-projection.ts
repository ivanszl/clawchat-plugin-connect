import { createHash, randomUUID } from "node:crypto";
import type {
  EmbeddedTranscriptBlock,
  MessageBlockContent,
  RuntimeInteractionBlock,
  RuntimeInteractionBlockContent,
  TranscriptBlock,
  TranscriptOrigin,
} from "../client-contract";
import { getAgentBinding } from "../config";
import type { ConnectStateStore, TranscriptBlockInput } from "../persistence/state";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import { type RuntimeActivity, type RuntimeTranscriptCompleteness, runtimeActivityOrdinal } from "../runtime/types";
import type { ConnectConfig, RuntimeSessionRecord } from "../types";

export interface TranscriptProjectionOptions {
  stateStore: ConnectStateStore;
  config: ConnectConfig;
  runtimeAdapters: RuntimeAdapterRegistry;
}

const MAX_EMBEDDED_SUBAGENT_DEPTH = 4;
const MAX_EMBEDDED_SUBAGENT_BYTES = 500 * 1024;
const MAX_SUBAGENT_LABEL_CHARACTERS = 16_000;
const SUBAGENT_OMISSION_TEXT = "Additional Sub-agent history was omitted to keep the Client Transcript bounded.";

export class TranscriptProjection {
  private readonly activeReconciliations = new Map<string, Promise<void>>();
  private readonly reconciledRuntimeRevisions = new Map<string, string>();
  private readonly transcriptCompleteness = new Map<string, RuntimeTranscriptCompleteness>();

  constructor(private readonly options: TranscriptProjectionOptions) {}

  async reconcile(session: RuntimeSessionRecord, sourceRevision?: string): Promise<void> {
    const revisionKey =
      session.runtimeSessionId && sourceRevision ? `${session.runtimeSessionId}:${sourceRevision}` : null;
    if (revisionKey && this.reconciledRuntimeRevisions.get(session.sessionRef) === revisionKey) return;
    const active = this.activeReconciliations.get(session.sessionRef);
    if (active) {
      await active;
      if (revisionKey && this.reconciledRuntimeRevisions.get(session.sessionRef) === revisionKey) return;
    }
    const reconciliation = this.reconcileFromRuntime(session)
      .then(() => {
        if (revisionKey) this.reconciledRuntimeRevisions.set(session.sessionRef, revisionKey);
      })
      .finally(() => {
        if (this.activeReconciliations.get(session.sessionRef) === reconciliation) {
          this.activeReconciliations.delete(session.sessionRef);
        }
      });
    this.activeReconciliations.set(session.sessionRef, reconciliation);
    return await reconciliation;
  }

  invalidate(sessionRef: string): void {
    this.reconciledRuntimeRevisions.delete(sessionRef);
    this.transcriptCompleteness.delete(sessionRef);
  }

  completeness(sessionRef: string): RuntimeTranscriptCompleteness | null {
    return this.transcriptCompleteness.get(sessionRef.toUpperCase()) ?? null;
  }

  private async reconcileFromRuntime(session: RuntimeSessionRecord): Promise<void> {
    await this.reconcileStoredSurfaceUserMessages(session.sessionRef);
    if (!session.runtimeSessionId) {
      this.transcriptCompleteness.set(session.sessionRef.toUpperCase(), "live-only");
      return;
    }
    const binding = getAgentBinding(this.options.config, session.agentId);
    const snapshot = await this.options.runtimeAdapters.readActivity(binding, session.runtimeSessionId);
    this.transcriptCompleteness.set(session.sessionRef.toUpperCase(), snapshot.completeness);
    const settlements: Array<NonNullable<ReturnType<typeof terminalTurnSettlement>>> = [];
    for (const activity of canonicalizeRuntimeActivities(snapshot.activities)) {
      await this.upsertProjectedRuntimeActivity(session.sessionRef, activity);
    }
    for (const activity of snapshot.activities) {
      const settlement = terminalTurnSettlement(activity);
      if (settlement) settlements.push(settlement);
    }
    for (const settlement of settlements) {
      await this.options.stateStore.settleStreamingTranscriptBlocks(
        session.sessionRef,
        settlement.sequenceRange,
        settlement.state,
      );
    }
  }

  private async reconcileStoredSurfaceUserMessages(sessionRef: string): Promise<void> {
    const blocks: TranscriptBlock[] = [];
    let beforeSequence: number | null = null;
    while (true) {
      const page = await this.options.stateStore.listTranscriptBlocks(sessionRef, { beforeSequence, limit: 200 });
      blocks.unshift(...page);
      if (page.length < 200) break;
      beforeSequence = page[0]?.sequence ?? null;
      if (beforeSequence === null) break;
    }
    const optimistic = blocks.filter(
      (block) =>
        block.type === "message" &&
        block.role === "user" &&
        (block.origin === "client" || block.origin === "clawchat") &&
        block.runtimeSource === undefined,
    );
    const history = blocks.filter(
      (block) =>
        block.type === "message" &&
        block.role === "user" &&
        block.origin === "runtime" &&
        block.runtimeSource === "history",
    );
    const claimed = new Set<string>();
    for (const candidate of optimistic) {
      const stable = history.find(
        (block) => !claimed.has(block.id) && clientPromptMatchesRuntimeHistory(candidate.plainText, block.plainText),
      );
      if (!stable) continue;
      claimed.add(stable.id);
      await this.options.stateStore.rekeyTranscriptBlock(
        sessionRef,
        candidate.id,
        preserveClientAuthoredPrompt(stable, candidate),
      );
    }
  }

  async appendUserMessage(params: {
    sessionRef: string;
    text: string;
    origin: "client" | "clawchat";
    author: string;
    sender?: MessageBlockContent["sender"];
    conversationType?: MessageBlockContent["conversationType"];
    id?: string;
    media?: MessageBlockContent["media"];
  }): Promise<TranscriptBlock> {
    const text = normalizeVisibleText(params.text);
    return (
      await this.options.stateStore.upsertTranscriptBlock(params.sessionRef, {
        id: params.id ?? randomUUID(),
        type: "message",
        origin: params.origin,
        state: "complete",
        plainText: text,
        role: "user",
        author: params.author,
        ...(params.sender ? { sender: params.sender } : {}),
        ...(params.conversationType ? { conversationType: params.conversationType } : {}),
        markdown: text,
        ...(params.media && params.media.length > 0 ? { media: params.media } : {}),
      })
    ).block;
  }

  async upsertRuntimeInteraction(
    sessionRef: string,
    input: RuntimeInteractionBlockContent,
  ): Promise<RuntimeInteractionBlock> {
    return (await this.options.stateStore.upsertTranscriptBlock(sessionRef, input)).block as RuntimeInteractionBlock;
  }

  async upsertRuntimeActivity(sessionRef: string, activity: RuntimeActivity): Promise<TranscriptBlock> {
    const [projectedActivity] = canonicalizeRuntimeActivities([activity]);
    if (!projectedActivity) throw new Error(`Runtime activity ${activity.id} could not be projected`);
    return await this.upsertProjectedRuntimeActivity(sessionRef, projectedActivity);
  }

  private async upsertProjectedRuntimeActivity(
    sessionRef: string,
    activity: RuntimeActivity,
  ): Promise<TranscriptBlock> {
    const input = this.fromRuntimeActivity(sessionRef, activity);
    const surfaceMessageId =
      activity.kind === "user"
        ? typeof activity.data?.clawchatMessageId === "string"
          ? activity.data.clawchatMessageId
          : typeof activity.data?.clientMessageId === "string"
            ? activity.data.clientMessageId
            : null
        : null;
    if (surfaceMessageId) {
      const block = await this.options.stateStore.rekeyTranscriptBlock(sessionRef, surfaceMessageId, input);
      if (block) return block;
    }
    for (const alias of activity.aliases ?? []) {
      if (alias === activity.id) continue;
      const block = await this.options.stateStore.rekeyTranscriptBlock(
        sessionRef,
        stableBlockId(sessionRef, alias),
        input,
      );
      if (block) return block;
    }
    if (activity.kind === "user") {
      const optimistic = (await this.options.stateStore.listTranscriptBlocks(sessionRef)).find(
        (block) =>
          block.type === "message" &&
          block.role === "user" &&
          (block.origin === "client" || block.origin === "clawchat") &&
          block.runtimeSource !== "history" &&
          clientPromptMatchesRuntimeHistory(block.plainText, input.plainText),
      );
      if (optimistic) {
        const block = await this.options.stateStore.rekeyTranscriptBlock(
          sessionRef,
          optimistic.id,
          preserveClientAuthoredPrompt(input, optimistic),
        );
        if (block) return block;
      }
    }
    return (await this.options.stateStore.upsertTranscriptBlock(sessionRef, input)).block;
  }

  async applyRuntimeDelivery(
    sessionRef: string,
    activity: RuntimeActivity,
    delivery: { text: string; media: NonNullable<MessageBlockContent["media"]> },
  ): Promise<TranscriptBlock> {
    const input = this.fromRuntimeActivity(sessionRef, activity);
    if (input.type !== "message" || input.role !== "assistant")
      return await this.upsertRuntimeActivity(sessionRef, activity);
    const text = normalizeVisibleText(delivery.text);
    return (
      await this.options.stateStore.upsertTranscriptBlock(sessionRef, {
        ...input,
        plainText: text,
        markdown: text,
        media: delivery.media,
      })
    ).block;
  }

  private fromRuntimeActivity(sessionRef: string, entry: RuntimeActivity, subagentDepth = 0): EmbeddedTranscriptBlock {
    const id = stableBlockId(sessionRef, entry.id);
    const text = normalizeHistoryText(entry.text);
    const base = {
      id,
      sequence: runtimeActivitySequence(entry.position),
      origin: historyOrigin(entry),
      runtimeSource: entry.source,
      state: entry.state,
      plainText: text,
    };
    if (entry.kind === "user") {
      return {
        ...base,
        type: "message" as const,
        role: "user" as const,
        author: base.origin === "clawchat" ? "ClawChat" : "You",
        markdown: text,
      };
    }
    if (entry.kind === "assistant") {
      return { ...base, type: "message" as const, role: "assistant" as const, author: "Agent", markdown: text };
    }
    if (entry.kind === "reasoning") return { ...base, type: "reasoning-summary" as const, markdown: text };
    if (entry.kind === "plan") return { ...base, type: "plan" as const, markdown: text };
    if (entry.kind === "command") {
      return {
        ...base,
        type: "command" as const,
        command: stringData(entry, "command"),
        output: text,
        status: stringData(entry, "status") || entry.state,
        exitCode: numberData(entry, "exitCode"),
      };
    }
    if (entry.kind === "file-change") {
      return {
        ...base,
        type: "file-change" as const,
        status: stringData(entry, "status") || entry.state,
        files: fileChanges(entry.data?.changes),
      };
    }
    if (entry.kind === "tool") {
      return {
        ...base,
        type: "tool-call" as const,
        title: stringData(entry, "title") || firstLine(text),
        status: stringData(entry, "status") || entry.state,
        detail: text,
      };
    }
    if (entry.kind === "progress" || entry.kind === "turn") {
      return { ...base, type: "progress" as const, label: text };
    }
    if (entry.kind === "subagent") {
      const subagentText = boundedSubagentLabel(text);
      const shell = {
        ...base,
        plainText: subagentText,
        type: "subagent" as const,
        title: boundedSubagentLabel(stringData(entry, "title") || "Sub-agent"),
        role: stringData(entry, "role") ? boundedSubagentLabel(stringData(entry, "role")) : null,
        activityKind: subagentActivityKind(entry.data?.activityKind),
        blocks: [] as EmbeddedTranscriptBlock[],
      };
      const markerBytes = Buffer.byteLength(JSON.stringify(subagentOmissionBlock(sessionRef, entry)));
      const wrapperBytes = Buffer.byteLength(JSON.stringify(shell));
      return {
        ...shell,
        blocks: this.projectSubagentChildren(
          sessionRef,
          entry,
          subagentDepth,
          Math.max(0, MAX_EMBEDDED_SUBAGENT_BYTES - wrapperBytes - markerBytes),
        ),
      };
    }
    if (entry.kind === "error") {
      return {
        ...base,
        type: "error" as const,
        code: stringData(entry, "code") || "runtime-failure",
        message: text,
        retryable: false,
      };
    }
    return { ...base, type: "unknown" as const, label: entry.kind, detail: text };
  }

  private projectSubagentChildren(
    sessionRef: string,
    entry: RuntimeActivity,
    subagentDepth: number,
    byteBudget: number,
  ): EmbeddedTranscriptBlock[] {
    const children = entry.children ?? [];
    if (children.length === 0) return [];
    if (subagentDepth >= MAX_EMBEDDED_SUBAGENT_DEPTH) {
      return [subagentOmissionBlock(sessionRef, entry)];
    }
    const blocks: EmbeddedTranscriptBlock[] = [];
    let serializedBytes = 2;
    let omitted = false;
    for (const child of children) {
      const block = this.fromRuntimeActivity(sessionRef, child, subagentDepth + 1);
      const blockBytes = Buffer.byteLength(JSON.stringify(block));
      if (serializedBytes + blockBytes > byteBudget) {
        if (!omitted) blocks.push(subagentOmissionBlock(sessionRef, entry));
        omitted = true;
        continue;
      }
      blocks.push(block);
      serializedBytes += blockBytes + 1;
    }
    return blocks;
  }
}

function subagentOmissionBlock(sessionRef: string, parent: RuntimeActivity): EmbeddedTranscriptBlock {
  return {
    id: stableBlockId(sessionRef, `${parent.id}:bounded-history`),
    origin: "runtime",
    runtimeSource: parent.source,
    state: "complete",
    plainText: SUBAGENT_OMISSION_TEXT,
    type: "progress",
    label: SUBAGENT_OMISSION_TEXT,
  };
}

function canonicalizeRuntimeActivities(activities: RuntimeActivity[]): RuntimeActivity[] {
  const latest = new Map<string, RuntimeActivity>();
  const childrenByParent = new Map<string, RuntimeActivity[]>();
  const visited = new WeakSet<RuntimeActivity>();
  const collect = (activity: RuntimeActivity): void => {
    if (visited.has(activity)) return;
    visited.add(activity);
    latest.set(activity.id, activity);
    for (const child of activity.children ?? []) {
      const children = childrenByParent.get(activity.id) ?? [];
      children.push(child);
      childrenByParent.set(activity.id, children);
      collect(child);
    }
  };
  for (const activity of activities) collect(activity);
  const placed = new Set<string>();
  const materialize = (placement: RuntimeActivity): RuntimeActivity | null => {
    if (placed.has(placement.id)) return null;
    placed.add(placement.id);
    const current = latest.get(placement.id) ?? placement;
    const { children: _latestChildren, ...latestFields } = current;
    const children = (childrenByParent.get(placement.id) ?? [])
      .map(materialize)
      .filter((child): child is RuntimeActivity => child !== null);
    return {
      ...latestFields,
      position: placement.position,
      parentId: placement.parentId,
      ...(children.length > 0 ? { children } : {}),
    };
  };
  return activities.map(materialize).filter((activity): activity is RuntimeActivity => activity !== null);
}

function boundedSubagentLabel(text: string): string {
  if (text.length <= MAX_SUBAGENT_LABEL_CHARACTERS) return text;
  return `${text.slice(0, MAX_SUBAGENT_LABEL_CHARACTERS)}\n\n${SUBAGENT_OMISSION_TEXT}`;
}

function clientPromptMatchesRuntimeHistory(clientPrompt: string, runtimePrompt: string): boolean {
  if (clientPrompt === runtimePrompt) return true;
  if (!clientPrompt.startsWith("/")) return false;
  return `$${clientPrompt.slice(1)}` === runtimePrompt;
}

function preserveClientAuthoredPrompt(
  runtimeInput: TranscriptBlockInput,
  clientBlock: TranscriptBlock,
): TranscriptBlockInput {
  if (
    runtimeInput.type !== "message" ||
    runtimeInput.role !== "user" ||
    clientBlock.type !== "message" ||
    clientBlock.role !== "user"
  ) {
    return runtimeInput;
  }
  return {
    ...runtimeInput,
    plainText: clientBlock.plainText,
    markdown: clientBlock.markdown,
  };
}

function runtimeActivitySequence(position: string): number | undefined {
  const ordinal = runtimeActivityOrdinal(position);
  if (!ordinal) return undefined;
  const { turn, item } = ordinal;
  if (turn >= 9_000_000_000 || item >= 1_000_000) return undefined;
  return (turn + 1) * 1_000_000 + item;
}

function terminalTurnSettlement(
  activity: RuntimeActivity,
): { sequenceRange: { first: number; next: number }; state: "error" | "cancelled" } | null {
  if (
    activity.source !== "history" ||
    activity.kind !== "turn" ||
    (activity.state !== "error" && activity.state !== "cancelled")
  ) {
    return null;
  }
  const ordinal = runtimeActivityOrdinal(activity.position);
  const first = runtimeActivitySequence(activity.position);
  return ordinal?.item === 0 && first !== undefined
    ? { sequenceRange: { first, next: first + 1_000_000 }, state: activity.state }
    : null;
}

function subagentActivityKind(value: unknown): "started" | "interacted" | "interrupted" | "unknown" {
  return value === "started" || value === "interacted" || value === "interrupted" ? value : "unknown";
}

function stableBlockId(sessionRef: string, nativeId: string): string {
  return `b_${createHash("sha256").update(`${sessionRef}\0${nativeId}`).digest("base64url").slice(0, 22)}`;
}

function historyOrigin(entry: RuntimeActivity): TranscriptOrigin {
  if (entry.kind !== "user") return "runtime";
  return /^ClawChat (?:direct|group) message from [^:]+:/u.test(entry.text) ? "clawchat" : "runtime";
}

function normalizeHistoryText(text: string): string {
  return normalizeVisibleText(text)
    .replace(/^<clawchat_turn_context>\n[\s\S]*?\n<\/clawchat_turn_context>\n*/u, "")
    .replace(/^ClawChat (?:direct|group) message from [^:]+:\s*/u, "");
}

function normalizeVisibleText(text: string): string {
  const normalized = text.replace(/\r\n?/gu, "\n");
  let visible = "";
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) visible += character;
  }
  return visible.trim();
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0]?.trim() || "Runtime activity";
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

function stringData(entry: RuntimeActivity, key: string): string {
  const value = entry.data?.[key];
  return typeof value === "string" ? value : "";
}

function numberData(entry: RuntimeActivity, key: string): number | null {
  const value = entry.data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fileChanges(value: unknown): Array<{ path: string; kind: string; diff: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const change = item as Record<string, unknown>;
    const path = typeof change.path === "string" ? change.path : "";
    if (!path) return [];
    return [
      {
        path,
        kind: typeof change.kind === "string" ? change.kind : "update",
        diff: typeof change.diff === "string" ? change.diff : "",
      },
    ];
  });
}
