import { randomUUID } from "node:crypto";
import type {
  RespondToRuntimeInteractionRequest,
  RuntimeInteractionBlock,
  RuntimeInteractionBlockContent,
} from "../client-contract";
import type { TranscriptProjection } from "../client-interface/transcript-projection";
import { RuntimeInteractionSettlement } from "./runtime-interaction-settlement";
import type { RuntimeInteractionPort, RuntimeInteractionRequest, RuntimeInteractionResponse } from "./types";

interface PendingInteraction {
  sessionRef: string;
  block: RuntimeInteractionBlock;
  request: RuntimeInteractionRequest;
  resolve(response: RuntimeInteractionResponse): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | null;
  removeAbortListener(): void;
  settlement: RuntimeInteractionSettlement<RuntimeInteractionResponse, RespondToRuntimeInteractionRequest>;
}

export class RuntimeInteractionCoordinator implements RuntimeInteractionPort {
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(private readonly transcriptProjection: TranscriptProjection) {}

  async request(
    request: RuntimeInteractionRequest,
    context: {
      sessionRef: string;
      turnId: string;
      origin: "client" | "clawchat";
      signal?: AbortSignal;
    },
  ): Promise<RuntimeInteractionResponse> {
    const interactionId = randomUUID();
    const autoResolutionAt =
      request.kind === "user-input" && request.autoResolutionMs !== null
        ? new Date(Date.now() + request.autoResolutionMs).toISOString()
        : null;
    const block = await this.transcriptProjection.upsertRuntimeInteraction(context.sessionRef, {
      id: `runtime-interaction:${interactionId}`,
      type: "runtime-interaction",
      origin: "runtime",
      state: "pending",
      plainText: `${request.title}\n${request.description}`.trim(),
      interactionId,
      interactionType: request.kind,
      action: request.kind === "approval" ? request.action : null,
      title: request.title,
      description: request.description,
      responseState: "pending",
      options: request.kind === "approval" ? request.options : [],
      questions: request.kind === "user-input" ? request.questions : [],
      command: request.kind === "approval" ? (request.command ?? null) : null,
      cwd: request.kind === "approval" ? (request.cwd ?? null) : null,
      files: request.kind === "approval" ? (request.files ?? []) : [],
      autoResolutionAt,
      resolvedOptionId: null,
      resolvedBy: null,
    });

    return await new Promise<RuntimeInteractionResponse>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => void this.expire(interactionId, "Runtime request ended");
      context.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.kind === "user-input" && request.autoResolutionMs !== null) {
        timeout = setTimeout(
          () => void this.expire(interactionId, "Response deadline expired"),
          request.autoResolutionMs,
        );
      }
      this.pending.set(interactionId, {
        sessionRef: context.sessionRef,
        block,
        request,
        resolve,
        reject,
        timeout,
        removeAbortListener: () => context.signal?.removeEventListener("abort", onAbort),
        settlement: new RuntimeInteractionSettlement({
          validate: (candidate) => validateResponse(request, candidate),
        }),
      });
    });
  }

  async respond(
    interactionId: string,
    response: RespondToRuntimeInteractionRequest,
    resolvedBy: "client" | "clawchat" = "client",
  ): Promise<RuntimeInteractionBlock> {
    const pending = this.pending.get(interactionId);
    if (!pending) throw new RuntimeInteractionError("interaction-not-pending", "Runtime interaction is not pending");
    let block: RuntimeInteractionBlock | null = null;
    const claimed = await pending.settlement.claim(response, async (normalized) => {
      block = await this.transcriptProjection.upsertRuntimeInteraction(
        pending.sessionRef,
        settledBlock(pending.block, normalized, resolvedBy),
      );
      pending.resolve(normalized);
      this.pending.delete(interactionId);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.removeAbortListener();
    });
    if (!claimed || !block)
      throw new RuntimeInteractionError("interaction-not-pending", "Runtime interaction is not pending");
    return block;
  }

  hasPending(sessionRef: string): boolean {
    return [...this.pending.values()].some((pending) => pending.sessionRef === sessionRef);
  }

  async expire(interactionId: string, reason: string): Promise<void> {
    const pending = this.pending.get(interactionId);
    if (!pending) return;
    if (!pending.settlement.expire()) return;
    this.pending.delete(interactionId);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbortListener();
    await this.transcriptProjection.upsertRuntimeInteraction(pending.sessionRef, {
      ...pending.block,
      state: "cancelled",
      plainText: `${pending.block.title}\n${reason}`,
      description: reason,
      responseState: "expired",
      resolvedBy: "system",
    });
    pending.reject(new RuntimeInteractionError("interaction-expired", reason));
  }

  async close(): Promise<void> {
    await Promise.all([...this.pending.keys()].map(async (id) => await this.expire(id, "Connect stopped")));
  }
}

export class RuntimeInteractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function validateResponse(
  request: RuntimeInteractionRequest,
  response: RespondToRuntimeInteractionRequest,
): RuntimeInteractionResponse {
  if (request.kind === "approval") {
    const option = request.options.find((candidate) => candidate.id === response.optionId);
    if (!option) throw new RuntimeInteractionError("invalid-interaction-response", "Select an available decision");
    return { kind: "approval", optionId: option.id };
  }
  const answers = response.answers;
  if (!answers || typeof answers !== "object") {
    throw new RuntimeInteractionError("invalid-interaction-response", "Answers are required");
  }
  const normalized: Record<string, string[]> = {};
  for (const question of request.questions) {
    const values = answers[question.id];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new RuntimeInteractionError("invalid-interaction-response", `Answer is required: ${question.header}`);
    }
    if (
      question.options &&
      !question.allowOther &&
      values.some((value) => !question.options?.some((option) => option.label === value || option.id === value))
    ) {
      throw new RuntimeInteractionError("invalid-interaction-response", `Invalid answer: ${question.header}`);
    }
    normalized[question.id] = values.map((value) => value.trim());
  }
  return { kind: "user-input", answers: normalized };
}

function settledBlock(
  block: RuntimeInteractionBlock,
  response: RuntimeInteractionResponse,
  resolvedBy: "client" | "clawchat",
): RuntimeInteractionBlockContent {
  const hasSecrets = block.questions.some((question) => question.secret);
  return {
    ...block,
    state: "complete",
    responseState: "resolved",
    resolvedOptionId: response.kind === "approval" ? response.optionId : null,
    resolvedBy,
    plainText:
      response.kind === "approval"
        ? `${block.title}\n${block.options.find((option) => option.id === response.optionId)?.label ?? response.optionId}`
        : `${block.title}\n${hasSecrets ? "已安全回答" : "已回答"}`,
  };
}
