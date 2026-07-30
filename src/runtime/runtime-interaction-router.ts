import { randomUUID } from "node:crypto";
import type { Envelope, Fragment, NormalizedInboundMessage } from "../protocol";
import { RuntimeInteractionSettlement } from "./runtime-interaction-settlement";
import type { RuntimeInteractionPort, RuntimeInteractionRequest, RuntimeInteractionResponse } from "./types";

interface RouterOptions {
  clientPort?: RuntimeInteractionPort;
  ownerUserId: string;
  ownerConversationId: string | null;
  sendClawChatMessage(fragments: Fragment[]): Promise<void>;
}

interface PendingClawChatInteraction {
  id: string;
  request: RuntimeInteractionRequest;
  answers: Record<string, string[]>;
  questionIndex: number;
  waitingForText: boolean;
  resolve(response: RuntimeInteractionResponse): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | null;
  removeAbortListener(): void;
  settlement: RuntimeInteractionSettlement<RuntimeInteractionResponse>;
}

interface ConnectInteractionAction {
  type: "connect_runtime_interaction";
  interaction_id: string;
  option_id?: string;
  question_id?: string;
  answer?: string;
}

export class RuntimeInteractionRouter implements RuntimeInteractionPort {
  private readonly pending = new Map<string, PendingClawChatInteraction>();

  constructor(private readonly options: RouterOptions) {}

  async request(
    request: RuntimeInteractionRequest,
    context: {
      sessionRef: string;
      turnId: string;
      origin: "client" | "clawchat";
      signal?: AbortSignal;
    },
  ): Promise<RuntimeInteractionResponse> {
    if (context.origin === "client") {
      if (!this.options.clientPort) throw new Error("Connect Client Runtime Interaction service is unavailable");
      return await this.options.clientPort.request(request, context);
    }
    if (!this.options.ownerConversationId) {
      throw new Error("ClawChat owner direct conversation is unavailable");
    }

    const id = randomUUID();
    const result = new Promise<RuntimeInteractionResponse>((resolve, reject) => {
      const onAbort = () => this.cancel(id, "Runtime request ended");
      context.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout =
        request.kind === "user-input" && request.autoResolutionMs !== null
          ? setTimeout(() => this.cancel(id, "Response deadline expired"), request.autoResolutionMs)
          : null;
      this.pending.set(id, {
        id,
        request,
        answers: {},
        questionIndex: 0,
        waitingForText: false,
        resolve,
        reject,
        timeout,
        removeAbortListener: () => context.signal?.removeEventListener("abort", onAbort),
        settlement: new RuntimeInteractionSettlement({
          validate: (response) => validateRuntimeResponse(request, response),
        }),
      });
    });
    const pending = this.pending.get(id);
    if (!pending) throw new Error("ClawChat Runtime Interaction was not initialized");
    try {
      await this.present(pending);
    } catch (error) {
      this.cancel(id, error instanceof Error ? error.message : String(error));
    }
    return await result;
  }

  async handleInteractionSubmit(envelope: Envelope): Promise<boolean> {
    const action = findConnectAction(envelope.payload);
    if (!action) return false;
    const pending = this.pending.get(action.interaction_id);
    if (!pending) return true;
    if (envelope.sender?.id !== this.options.ownerUserId || envelope.chat_id !== this.options.ownerConversationId) {
      return true;
    }

    if (pending.request.kind === "approval") {
      const option = pending.request.options.find((candidate) => candidate.id === action.option_id);
      if (!option) return true;
      await this.settle(pending, { kind: "approval", optionId: option.id });
      return true;
    }

    const question = pending.request.questions[pending.questionIndex];
    if (!question || action.question_id !== question.id) return true;
    if (action.option_id === "__other__") {
      pending.waitingForText = true;
      await this.options.sendClawChatMessage([{ kind: "text", text: `${question.header}：请直接回复你的答案。` }]);
      return true;
    }
    const option = question.options?.find(
      (candidate) => candidate.id === action.option_id || candidate.label === action.answer,
    );
    if (!option) return true;
    pending.answers[question.id] = [option.label];
    pending.questionIndex += 1;
    await this.present(pending);
    return true;
  }

  async handleMessage(message: NormalizedInboundMessage): Promise<boolean> {
    if (
      message.sender.id !== this.options.ownerUserId ||
      message.chatId !== this.options.ownerConversationId ||
      message.chatType !== "direct"
    ) {
      return false;
    }
    const approval = [...this.pending.values()].find((candidate) => candidate.request.kind === "approval");
    if (approval?.request.kind === "approval") {
      const optionId = approvalOptionId(message.text);
      if (!optionId) return false;
      await this.settle(approval, { kind: "approval", optionId });
      return true;
    }
    const selection = [...this.pending.values()].find((candidate) => {
      if (candidate.request.kind !== "user-input") return false;
      return Boolean(candidate.request.questions[candidate.questionIndex]?.options?.length);
    });
    if (selection?.request.kind === "user-input") {
      const question = selection.request.questions[selection.questionIndex];
      const option = numberedOption(message.text, question?.options ?? null);
      if (!option || !question) return false;
      selection.answers[question.id] = [option.label];
      selection.questionIndex += 1;
      await this.present(selection);
      return true;
    }
    const pending = [...this.pending.values()].find((candidate) => candidate.waitingForText);
    if (pending?.request.kind !== "user-input") return false;
    const answer = message.text.trim();
    if (!answer) return true;
    const question = pending.request.questions[pending.questionIndex];
    if (!question) return false;
    pending.answers[question.id] = [answer];
    pending.waitingForText = false;
    pending.questionIndex += 1;
    await this.present(pending);
    return true;
  }

  async close(): Promise<void> {
    for (const pending of [...this.pending.values()]) this.cancel(pending.id, "Connect stopped");
  }

  private async present(pending: PendingClawChatInteraction): Promise<void> {
    if (pending.request.kind === "approval") {
      await this.options.sendClawChatMessage([
        {
          kind: "text",
          text: `${pending.request.title}\n${pending.request.description}\n\n/approve 仅此次允许\n/approve session 本 Session 允许\n/deny 拒绝`,
        },
      ]);
      return;
    }

    const question = pending.request.questions[pending.questionIndex];
    if (!question) {
      await this.settle(pending, { kind: "user-input", answers: pending.answers });
      return;
    }
    if (question.secret) {
      await this.options.sendClawChatMessage([
        {
          kind: "text",
          text: `${question.header}：ClawChat 当前没有安全输入控件，本次请求已取消，答案不会通过普通消息收集。`,
        },
      ]);
      this.cancel(pending.id, "ClawChat does not provide a secure input control");
      return;
    }
    if (!question.options?.length) {
      pending.waitingForText = true;
      await this.options.sendClawChatMessage([
        { kind: "text", text: `${question.header}：${question.prompt}\n请直接回复你的答案。` },
      ]);
      return;
    }
    const choices = question.options.map((option, index) => `/${index + 1} ${option.label}`).join("\n");
    await this.options.sendClawChatMessage([
      {
        kind: "text",
        text: `${question.header}：${question.prompt}\n\n${choices}${
          question.allowOther ? "\n直接回复其他答案。" : ""
        }`,
      },
    ]);
  }

  private async settle(pending: PendingClawChatInteraction, response: RuntimeInteractionResponse): Promise<void> {
    await pending.settlement.claim(response, async (validated) => {
      this.pending.delete(pending.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.removeAbortListener();
      pending.resolve(validated);
    });
  }

  private cancel(id: string, reason: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (!pending.settlement.expire()) return;
    this.pending.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbortListener();
    pending.reject(new Error(reason));
  }
}

function approvalOptionId(text: string): "approve-once" | "approve-session" | "deny" | null {
  const command = text.trim().toLowerCase().replace(/\s+/gu, " ");
  if (command === "/approve") return "approve-once";
  if (command === "/approve session") return "approve-session";
  if (command === "/deny") return "deny";
  return null;
}

function numberedOption<T>(text: string, options: T[] | null): T | null {
  if (!options) return null;
  const match = /^\/(\d+)$/u.exec(text.trim());
  const index = Number(match?.[1] ?? 0) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? (options[index] ?? null) : null;
}

function validateRuntimeResponse(
  request: RuntimeInteractionRequest,
  response: RuntimeInteractionResponse,
): RuntimeInteractionResponse {
  if (request.kind !== response.kind) throw new Error("Runtime Interaction response kind does not match request");
  if (request.kind === "approval") {
    if (response.kind !== "approval" || !request.options.some((option) => option.id === response.optionId)) {
      throw new Error("Runtime Interaction approval decision is invalid");
    }
    return response;
  }
  if (response.kind !== "user-input") throw new Error("Runtime Interaction answers are invalid");
  for (const question of request.questions) {
    const answers = response.answers[question.id];
    if (!answers?.length || answers.some((answer) => !answer.trim())) {
      throw new Error(`Runtime Interaction answer is required: ${question.header}`);
    }
  }
  return response;
}

function findConnectAction(value: unknown, depth = 0): ConnectInteractionAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return null;
  const record = value as Record<string, unknown>;
  if (
    record.type === "connect_runtime_interaction" &&
    typeof record.interaction_id === "string" &&
    record.interaction_id
  ) {
    return record as unknown as ConnectInteractionAction;
  }
  for (const key of ["payload", "action", "interaction", "submission", "data"]) {
    const nested = findConnectAction(record[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}
