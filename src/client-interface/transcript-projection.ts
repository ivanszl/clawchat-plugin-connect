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
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { RuntimeActivity, RuntimeTranscriptCompleteness } from "../runtime/types";
import type { ConnectStateStore } from "../state";
import type { ConnectConfig, RuntimeSessionRecord } from "../types";

export interface TranscriptProjectionOptions {
  stateStore: ConnectStateStore;
  config: ConnectConfig;
  runtimeAdapters: RuntimeAdapterRegistry;
}

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
    if (!session.runtimeSessionId) {
      this.transcriptCompleteness.set(session.sessionRef.toUpperCase(), "live-only");
      return;
    }
    const binding = getAgentBinding(this.options.config, session.agentId);
    const snapshot = await this.options.runtimeAdapters.readActivity(binding, session.runtimeSessionId);
    this.transcriptCompleteness.set(session.sessionRef.toUpperCase(), snapshot.completeness);
    for (const activity of snapshot.activities) {
      const input = this.fromRuntimeActivity(session.sessionRef, activity);
      let rekeyed = false;
      for (const alias of activity.aliases ?? []) {
        if (alias === activity.id) continue;
        const block = await this.options.stateStore.rekeyTranscriptBlock(
          session.sessionRef,
          stableBlockId(session.sessionRef, alias),
          input,
        );
        if (block) {
          rekeyed = true;
          break;
        }
      }
      if (rekeyed) continue;
      await this.options.stateStore.upsertTranscriptBlock(session.sessionRef, input);
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
    return (
      await this.options.stateStore.upsertTranscriptBlock(sessionRef, this.fromRuntimeActivity(sessionRef, activity))
    ).block;
  }

  private fromRuntimeActivity(sessionRef: string, entry: RuntimeActivity): EmbeddedTranscriptBlock {
    const id = stableBlockId(sessionRef, entry.id);
    const text = normalizeHistoryText(entry.text);
    const base = {
      id,
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
    if (entry.kind === "progress") return { ...base, type: "progress" as const, label: text };
    if (entry.kind === "subagent") {
      return {
        ...base,
        type: "subagent" as const,
        title: stringData(entry, "title") || "Sub-agent",
        role: stringData(entry, "role") || null,
        activityKind: subagentActivityKind(entry.data?.activityKind),
        blocks: (entry.children ?? []).map((child) => this.fromRuntimeActivity(sessionRef, child)),
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
  return normalizeVisibleText(text).replace(/^ClawChat (?:direct|group) message from [^:]+:\s*/u, "");
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
