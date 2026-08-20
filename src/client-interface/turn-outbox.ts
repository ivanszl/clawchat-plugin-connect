import type { StartTurnResponse, TurnSubmissionErrorView } from "../client-contract";
import type { ConnectStateStore, TurnOutboxRecord } from "../persistence/state";
import type { ConnectRuntimeMedia } from "../runtime/types";
import { ClientRequestError } from "./client-http";
import type { TranscriptProjection } from "./transcript-projection";
import { type TurnSubmissionDraft, type TurnSubmissionStaging, validateDraft } from "./turn-submission";

export interface TurnOutboxStaging extends TurnSubmissionStaging {
  mediaForReference(reference: string): Promise<ConnectRuntimeMedia[]>;
  remove(reference: string): Promise<void>;
}

export interface TurnOutboxOptions {
  stateStore: ConnectStateStore;
  staging: TurnOutboxStaging;
  transcriptProjection: TranscriptProjection;
  capabilityFor(sessionRef: string): Promise<import("../client-contract").TurnSubmissionCapability>;
  deliver(
    record: TurnOutboxRecord,
    media: ConnectRuntimeMedia[],
    signal: AbortSignal,
  ): Promise<{ turnId: string; sessionRef: string }>;
  onChanged?(sessionRef: string): void | Promise<void>;
}

export class TurnOutboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TurnOutboxError";
  }
}

export class TurnOutbox {
  private draining: Promise<void> | null = null;
  private scheduled = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(private readonly options: TurnOutboxOptions) {}

  async start(): Promise<void> {
    const interrupted = (await this.options.stateStore.listRecoverableTurnOutbox()).filter(
      (record) => record.state === "delivering",
    );
    await this.options.stateStore.failInterruptedTurnOutbox({
      code: "submission-outcome-unknown",
      message: "Connect restarted before Runtime acceptance could be confirmed",
      retryable: true,
    });
    for (const record of interrupted) {
      const failed = await this.options.stateStore.getTurnOutbox(record.submissionId);
      if (failed) await this.project(failed);
    }
    for (const record of await this.options.stateStore.listRecoverableTurnOutbox()) await this.ensureMessage(record);
    this.schedule();
  }

  async submit(draft: TurnSubmissionDraft, signal?: AbortSignal): Promise<StartTurnResponse> {
    validateDraft(draft, await this.options.capabilityFor(draft.sessionRef));
    signal?.throwIfAborted();
    const staged = await this.options.staging.stage(draft, signal);
    if (signal?.aborted) {
      await staged.rollback();
      signal.throwIfAborted();
    }
    const messageId = `turn_${draft.submissionId}_user`;
    const created = await this.options.stateStore.createTurnOutbox({
      submissionId: draft.submissionId,
      sessionRef: draft.sessionRef,
      messageId,
      digest: staged.digest,
      prompt: draft.prompt,
      selection: draft.selection ?? null,
      stagingRef: staged.reference,
    });
    if (!created.created) {
      await staged.rollback();
      if (created.reason === "conflict" || created.reason === "reserved") {
        throw new TurnOutboxError(409, "request-id-conflict", "Submission identity was used by another Client command");
      }
      await this.ensureMessage(created.record);
      this.schedule();
      return outboxView(created.record);
    }
    staged.transfer();
    await this.ensureMessage(created.record);
    this.schedule();
    return outboxView(created.record);
  }

  async get(sessionRef: string, submissionId: string): Promise<StartTurnResponse | null> {
    const record = await this.options.stateStore.getTurnOutbox(submissionId);
    return record?.sessionRef === sessionRef ? outboxView(record) : null;
  }

  async retry(sessionRef: string, submissionId: string): Promise<StartTurnResponse | null> {
    const current = await this.options.stateStore.getTurnOutbox(submissionId);
    if (!current || current.sessionRef !== sessionRef || current.state !== "failed") return null;
    const record = await this.options.stateStore.retryTurnOutbox(submissionId, sessionRef);
    if (!record) return null;
    await this.project(record);
    this.schedule();
    return outboxView(record);
  }

  async discard(sessionRef: string, submissionId: string): Promise<boolean> {
    let current = await this.options.stateStore.getTurnOutbox(submissionId);
    if (!current || current.sessionRef !== sessionRef || current.state === "accepted") return false;
    if (current.state === "delivering") {
      this.controllers.get(submissionId)?.abort();
      await this.deliveries.get(submissionId)?.catch(() => undefined);
      current = await this.options.stateStore.getTurnOutbox(submissionId);
    }
    if (!current || current.state === "delivering" || current.state === "accepted") return false;
    const discarded = await this.options.stateStore.discardTurnOutbox(submissionId, sessionRef);
    if (!discarded) return false;
    await Promise.all([
      this.options.stateStore.removeTranscriptBlock(sessionRef, discarded.messageId),
      this.options.staging.remove(discarded.stagingRef),
    ]);
    await this.options.onChanged?.(sessionRef);
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (this.scheduled || this.draining) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.draining) return;
      const draining = this.drain().finally(() => {
        if (this.draining === draining) this.draining = null;
      });
      this.draining = draining;
    });
  }

  private async drain(): Promise<void> {
    while (true) {
      const record = await this.options.stateStore.claimNextTurnOutbox();
      if (!record) return;
      const delivery = this.deliver(record);
      this.deliveries.set(record.submissionId, delivery);
      try {
        await delivery;
      } finally {
        this.deliveries.delete(record.submissionId);
      }
    }
  }

  private async deliver(record: TurnOutboxRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(record.submissionId, controller);
    try {
      await this.project(record);
      const media = await this.options.staging.mediaForReference(record.stagingRef);
      const accepted = await this.options.deliver(record, media, controller.signal);
      const stored = await this.options.stateStore.acceptTurnOutbox(record.submissionId, accepted.turnId);
      if (stored) await this.project(stored);
    } catch (error) {
      const stored = await this.options.stateStore.failTurnOutbox(record.submissionId, deliveryError(error));
      if (stored) await this.project(stored);
    } finally {
      this.controllers.delete(record.submissionId);
      await this.options.onChanged?.(record.sessionRef);
    }
  }

  private async ensureMessage(record: TurnOutboxRecord): Promise<void> {
    const existing = await this.options.stateStore.getTranscriptBlock(record.sessionRef, record.messageId);
    if (existing?.type === "message" && existing.role === "user" && existing.origin === "client") {
      await this.project(record);
      return;
    }
    const media = await this.options.staging.mediaForReference(record.stagingRef);
    await this.options.transcriptProjection.appendUserMessage({
      sessionRef: record.sessionRef,
      text: record.prompt,
      origin: "client",
      author: "You",
      id: record.messageId,
      state: record.state === "failed" ? "error" : record.state === "accepted" ? "complete" : "pending",
      delivery: deliveryView(record),
      media: media.map((item) => ({
        kind: item.kind,
        url: item.url,
        name: item.name ?? null,
        mime: item.mime ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
      })),
    });
  }

  private async project(record: TurnOutboxRecord): Promise<void> {
    await this.options.transcriptProjection.updateClientMessageDelivery(
      record.sessionRef,
      record.messageId,
      record.state === "failed" ? "error" : record.state === "accepted" ? "complete" : "pending",
      deliveryView(record),
    );
  }
}

function deliveryView(record: TurnOutboxRecord) {
  if (record.state === "accepted") return undefined;
  if (record.state === "failed") {
    return {
      submissionId: record.submissionId,
      state: "failed" as const,
      error: record.error,
      allowedActions: ["retry", "discard"] as Array<"retry" | "discard">,
    };
  }
  return {
    submissionId: record.submissionId,
    state: "pending" as const,
    error: null,
    allowedActions: ["cancel"] as Array<"cancel">,
  };
}

function outboxView(record: TurnOutboxRecord): StartTurnResponse {
  return {
    submissionId: record.submissionId,
    messageId: record.messageId,
    sessionRef: record.sessionRef,
    state: record.state,
    turnId: record.turnId,
    error: record.error,
  };
}

function deliveryError(error: unknown): TurnSubmissionErrorView {
  if (error instanceof ClientRequestError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "submission-cancelled", message: "Turn Submission was cancelled", retryable: true };
  }
  return {
    code: "submission-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
