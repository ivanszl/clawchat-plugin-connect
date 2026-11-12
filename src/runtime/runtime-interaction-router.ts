import { randomUUID } from "node:crypto";
import { isConnectControlMessage, requiresOrderedSessionControl } from "../clawchat/chat-commands";
import { addressInboundMessage, commandAddressPrefix } from "../clawchat/message-mapper";
import type { Envelope, Fragment, NormalizedInboundMessage, Sender } from "../clawchat/protocol";
import { RuntimeInteractionSettlement } from "./runtime-interaction-settlement";
import type {
  ClawChatInteractionRoute,
  RuntimeInteractionContext,
  RuntimeInteractionPort,
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
} from "./types";

/** How long an approval may wait for a human decision before it is denied automatically. */
export const APPROVAL_DEADLINE_MS = 30 * 60 * 1000;

interface RouterOptions {
  /** Overrides {@link APPROVAL_DEADLINE_MS}; intended for tests. */
  approvalDeadlineMs?: number;
  clientInteractions?: RuntimeInteractionPort;
  ownerUserId: string;
  ownerConversationId: string | null;
  agentUserId?: string;
  agentDisplayName?: string;
  resolveSenderDisplayName?(senderId: string): Promise<string | null>;
  sendClawChatMessage(delivery: ClawChatInteractionDelivery): Promise<void>;
}

export interface ClawChatInteractionDelivery extends ClawChatInteractionRoute {
  interactionId: string | null;
  fragments: Fragment[];
}

interface PendingClawChatInteraction {
  id: string;
  sessionRef: string;
  route: ClawChatInteractionRoute;
  request: RuntimeInteractionRequest;
  answers: Record<string, string[]>;
  questionIndex: number;
  waitingForText: boolean;
  lastAnswerResponder: { id: string; displayName: string } | null;
  resolve(response: RuntimeInteractionResponse): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | null;
  deliveryConfirmation: Promise<void>;
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

type RuntimeInteractionQuestion = Extract<RuntimeInteractionRequest, { kind: "user-input" }>["questions"][number];

export function isRuntimeInteractionResponseText(text: string): boolean {
  return runtimeResponseKind(text) !== null || approvalOptionId(text) !== null;
}

export class RuntimeInteractionRouter implements RuntimeInteractionPort {
  private readonly pending = new Map<string, PendingClawChatInteraction>();
  private readonly terminalResponses = new Map<string, string>();
  private readonly terminalInteractions = new Map<
    string,
    {
      route: Pick<ClawChatInteractionRoute, "chatId" | "chatType">;
      responderId: string | null;
      text: string;
    }
  >();

  constructor(private readonly options: RouterOptions) {}

  async request(
    request: RuntimeInteractionRequest,
    context: RuntimeInteractionContext,
  ): Promise<RuntimeInteractionResponse> {
    if (!context.deliveryConfirmation) {
      throw new Error("Native delivery confirmation is required for a Runtime Interaction");
    }
    if (context.origin === "client") {
      if (!this.options.clientInteractions) {
        throw new Error("Connect Client Runtime Interaction service is unavailable");
      }
      return await this.options.clientInteractions.request(request, context);
    }
    const route = context.clawchat;
    if (!route) {
      throw new Error("Originating ClawChat conversation route is required");
    }

    const id = randomUUID();
    const result = new Promise<RuntimeInteractionResponse>((resolve, reject) => {
      const onAbort = () => void this.cancel(id, "Runtime request ended");
      context.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout =
        request.kind === "approval"
          ? setTimeout(() => void this.expireApproval(id), this.options.approvalDeadlineMs ?? APPROVAL_DEADLINE_MS)
          : request.autoResolutionMs !== null
            ? setTimeout(() => void this.cancel(id, "Response deadline expired"), request.autoResolutionMs)
            : null;
      this.pending.set(id, {
        id,
        sessionRef: context.sessionRef,
        route,
        request,
        answers: {},
        questionIndex: 0,
        waitingForText: false,
        lastAnswerResponder: null,
        resolve,
        reject,
        timeout,
        deliveryConfirmation: context.deliveryConfirmation,
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
      await this.cancel(id, error instanceof Error ? error.message : String(error));
    }
    return await result;
  }

  async handleInteractionSubmit(envelope: Envelope): Promise<boolean> {
    const action = findConnectAction(envelope.payload);
    if (!action) return false;
    const pending = this.pending.get(action.interaction_id);
    if (!pending) {
      const terminal = this.terminalInteractions.get(action.interaction_id);
      if (terminal && envelope.chat_id === terminal.route.chatId && envelope.chat_type === terminal.route.chatType) {
        const text =
          terminal.responderId && terminal.responderId === envelope.sender?.id
            ? `Your response was already recorded. ${terminal.text}`
            : terminal.text;
        await this.options.sendClawChatMessage({
          chatId: terminal.route.chatId,
          chatType: terminal.route.chatType,
          sourceMessageId: null,
          interactionId: action.interaction_id,
          fragments: [{ kind: "text", text }],
        });
      }
      return true;
    }
    if (
      envelope.chat_id !== pending.route.chatId ||
      envelope.chat_type !== pending.route.chatType ||
      (pending.route.chatType === "direct" && envelope.sender?.id !== this.options.ownerUserId)
    ) {
      return true;
    }

    if (pending.request.kind === "approval") {
      const option = pending.request.options.find((candidate) => candidate.id === action.option_id);
      if (!option) return true;
      const responder = envelope.sender ? await this.resolvedResponder(envelope.sender) : undefined;
      await this.settle(pending, { kind: "approval", optionId: option.id }, responder);
      return true;
    }

    const question = pending.request.questions[pending.questionIndex];
    if (!question || action.question_id !== question.id) return true;
    const structuredAnswer = typeof action.answer === "string" ? action.answer.trim() : "";
    if (
      structuredAnswer &&
      !question.secret &&
      (!question.options?.length || question.allowOther) &&
      action.option_id !== "__other__"
    ) {
      pending.answers[question.id] = [structuredAnswer];
      pending.questionIndex += 1;
      if (envelope.sender) {
        await this.acknowledgeAnswer(pending, question, await this.resolvedSender(envelope.sender), null);
      }
      await this.present(pending);
      return true;
    }
    if (action.option_id === "__other__") {
      pending.waitingForText = true;
      const prefix = commandAddressPrefix(pending.route.chatType);
      await this.send(pending, [
        {
          kind: "text",
          text: `${questionPresentationHeader(pending)}：请使用 ${prefix}/answer <答案>。`,
        },
      ]);
      return true;
    }
    const option = question.options?.find(
      (candidate) => candidate.id === action.option_id || candidate.label === action.answer,
    );
    if (!option) return true;
    pending.answers[question.id] = [option.label];
    pending.questionIndex += 1;
    if (envelope.sender) {
      await this.acknowledgeAnswer(pending, question, await this.resolvedSender(envelope.sender), option.label);
    }
    await this.present(pending);
    return true;
  }

  async handleMessage(message: NormalizedInboundMessage): Promise<boolean> {
    if (
      message.chatType === "direct" &&
      (message.sender.id !== this.options.ownerUserId || message.chatId !== this.options.ownerConversationId)
    ) {
      return false;
    }
    const routedMessage = addressInboundMessage(message, this.options.agentUserId ?? "");
    if (!routedMessage || (!routedMessage.acceptsCommands && !routedMessage.malformedLineBreakCommand)) return false;
    message = await this.withResolvedSenderDisplayName(message);
    const eligible = [...this.pending.values()].filter(
      (candidate) =>
        candidate.route.chatId === message.chatId &&
        candidate.route.chatType === message.chatType &&
        (message.chatType === "group" || message.sender.id === this.options.ownerUserId),
    );
    const responseText = routedMessage.message.text;
    const responseKind = runtimeResponseKind(responseText);
    if (responseKind && (routedMessage.hasAttachment || /[\r\n]/u.test(responseText))) {
      await this.sendForMessage(message, [
        { kind: "text", text: runtimeResponseUsage(message.chatType, responseKind) },
      ]);
      return true;
    }
    const optionId = approvalOptionId(responseText);
    if (!optionId && approvalOptionId(responseText.toLowerCase())) {
      const canonical = responseText
        .trim()
        .toLowerCase()
        .replace(/[ \t]+/gu, " ");
      await this.sendForMessage(message, [
        {
          kind: "text",
          text: `Usage: ${commandAddressPrefix(message.chatType)}${canonical}`,
        },
      ]);
      return true;
    }
    if (optionId) {
      const approvals = eligible.filter((candidate) => candidate.request.kind === "approval");
      if (approvals.length === 0) {
        const terminal = this.terminalResponses.get(routeResponseKey(message, "approval"));
        await this.sendForMessage(message, [
          {
            kind: "text",
            text: terminal ?? "No pending approval is waiting in this conversation.",
          },
        ]);
        return true;
      }
      if (approvals.length > 1) {
        await this.send(approvals[0], [
          {
            kind: "text",
            text: "Cannot respond: multiple pending approvals are waiting in this conversation. Use a structured action.",
          },
        ]);
        return true;
      }
      const approval = approvals[0];
      if (approval.request.kind !== "approval") return true;
      await this.settle(
        approval,
        { kind: "approval", optionId },
        {
          id: message.sender.id,
          displayName: message.sender.nick_name || message.sender.id,
        },
      );
      return true;
    }
    if (responseKind === "approval") {
      await this.sendForMessage(message, [
        { kind: "text", text: runtimeResponseUsage(message.chatType, responseKind) },
      ]);
      return true;
    }
    const customAnswer = freeTextAnswer(responseText);
    if (customAnswer !== null) {
      const questions = eligible.filter(
        (candidate) =>
          candidate.request.kind === "user-input" && Boolean(candidate.request.questions[candidate.questionIndex]),
      );
      const answerable = questions.filter((candidate) => {
        if (candidate.request.kind !== "user-input") return false;
        const question = candidate.request.questions[candidate.questionIndex];
        return Boolean(question && !question.secret && (!question.options?.length || question.allowOther));
      });
      if (answerable.length > 1) {
        await this.send(answerable[0], [
          {
            kind: "text",
            text: "Cannot respond: multiple pending questions are waiting in this conversation. Use a structured action.",
          },
        ]);
        return true;
      }
      const pendingAnswer = answerable[0];
      if (pendingAnswer?.request.kind === "user-input") {
        const question = pendingAnswer.request.questions[pendingAnswer.questionIndex];
        if (!question) return true;
        pendingAnswer.answers[question.id] = [customAnswer];
        pendingAnswer.waitingForText = false;
        pendingAnswer.questionIndex += 1;
        await this.acknowledgeAnswer(pendingAnswer, question, message.sender, null);
        await this.present(pendingAnswer);
        return true;
      }
      const disallowed = questions[0];
      if (disallowed) {
        await this.present(disallowed);
      } else {
        const terminal = this.terminalResponses.get(routeResponseKey(message, "question"));
        await this.sendForMessage(message, [
          {
            kind: "text",
            text: terminal ?? "No pending free-text question is waiting in this conversation.",
          },
        ]);
      }
      return true;
    }
    if (responseKind === "answer") {
      await this.sendForMessage(message, [
        { kind: "text", text: runtimeResponseUsage(message.chatType, responseKind) },
      ]);
      return true;
    }
    const numberedResponse = /^\/\d/iu.test(responseText.trim());
    const selections = eligible.filter((candidate) => {
      if (candidate.request.kind !== "user-input") return false;
      return Boolean(candidate.request.questions[candidate.questionIndex]?.options?.length);
    });
    if (numberedResponse && selections.length > 1) {
      await this.send(selections[0], [
        {
          kind: "text",
          text: "Cannot respond: multiple pending choices are waiting in this conversation. Use a structured action.",
        },
      ]);
      return true;
    }
    const selection = selections[0];
    if (numberedResponse && selection?.request.kind === "user-input") {
      const question = selection.request.questions[selection.questionIndex];
      const option = numberedOption(responseText, question?.options ?? null);
      if (!option || !question) {
        await this.present(selection);
        return true;
      }
      selection.answers[question.id] = [option.label];
      selection.questionIndex += 1;
      await this.acknowledgeAnswer(selection, question, message.sender, option.label);
      await this.present(selection);
      return true;
    }
    if (numberedResponse && selections.length === 0) {
      const terminal = this.terminalResponses.get(routeResponseKey(message, "question"));
      await this.sendForMessage(message, [
        {
          kind: "text",
          text: terminal ?? "No pending choice is waiting in this conversation.",
        },
      ]);
      return true;
    }
    return await this.holdMessageBehindPendingInteraction(message, responseText, eligible);
  }

  /**
   * A plain message that arrives while a Runtime Interaction of the same conversation is pending would queue behind
   * the Turn blocked on that Interaction and stall the Session. It is not queued: the sender is told what is pending
   * and must resend the message after answering. The message is dropped, not retained.
   */
  private async holdMessageBehindPendingInteraction(
    message: NormalizedInboundMessage,
    text: string,
    eligible: PendingClawChatInteraction[],
  ): Promise<boolean> {
    const pending = eligible[0];
    if (!pending) return false;
    if (isConnectControlMessage(text) && !requiresOrderedControl(text, message.sender.id, this.options.ownerUserId)) {
      return false;
    }
    await this.sendForMessage(message, [{ kind: "text", text: pendingInteractionHint(pending, message.chatType) }]);
    return true;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.pending.values()].map(async (pending) => await this.cancel(pending.id, "Connect stopped")),
    );
  }

  private async present(pending: PendingClawChatInteraction): Promise<void> {
    const commandPrefix = commandAddressPrefix(pending.route.chatType);
    if (pending.request.kind === "approval") {
      const title =
        pending.request.action === "file-change"
          ? "Runtime file-change approval requested"
          : "Runtime command approval requested";
      const description = "Review the Runtime request and choose one of the Connect decisions below.";
      await this.send(pending, [
        {
          kind: "text",
          text: `${groupSessionPrefix(pending)}${title}\n${description}\n\n${commandPrefix}/approve 仅此次允许\n${commandPrefix}/approve session 本 Session 允许\n${commandPrefix}/deny 拒绝`,
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
      await this.send(pending, [
        {
          kind: "text",
          text: `${groupSessionPrefix(pending)}${questionPresentationHeader(pending)}：ClawChat 当前没有安全输入控件，本次请求已取消，答案不会通过普通消息收集。`,
        },
      ]);
      await this.cancel(pending.id, "ClawChat does not provide a secure input control");
      return;
    }
    if (!question.options?.length) {
      pending.waitingForText = true;
      const header = questionPresentationHeader(pending);
      const prompt =
        pending.route.chatType === "group"
          ? "Provide a free-text answer."
          : presentationText(question.prompt, "Enter an answer", 500);
      await this.send(pending, [
        {
          kind: "text",
          text: `${groupSessionPrefix(pending)}${header}：${prompt}\n请使用 ${commandPrefix}/answer <答案>。`,
        },
      ]);
      return;
    }
    const header = questionPresentationHeader(pending);
    const prompt =
      pending.route.chatType === "group"
        ? "Choose one of the available options."
        : presentationText(question.prompt, "Choose an option", 500);
    const choices = question.options
      .map(
        (option, index) =>
          `${commandPrefix}/${index + 1} ${
            pending.route.chatType === "group"
              ? `Option ${index + 1}`
              : presentationText(option.label, `Option ${index + 1}`, 120)
          }`,
      )
      .join("\n");
    await this.send(pending, [
      {
        kind: "text",
        text: `${groupSessionPrefix(pending)}${header}：${prompt}\n\n${choices}${
          question.allowOther ? `\n使用 ${commandPrefix}/answer <答案> 提交其他答案。` : ""
        }`,
      },
    ]);
  }

  private async send(pending: PendingClawChatInteraction, fragments: Fragment[]): Promise<void> {
    await this.options.sendClawChatMessage({
      ...pending.route,
      interactionId: pending.id,
      fragments: this.structuredGroupCommandMentions(pending.route.chatType, fragments),
    });
  }

  private async sendForMessage(message: NormalizedInboundMessage, fragments: Fragment[]): Promise<void> {
    await this.options.sendClawChatMessage({
      chatId: message.chatId,
      chatType: message.chatType,
      sourceMessageId: message.messageId,
      sourceSender: {
        id: message.sender.id,
        displayName: message.sender.nick_name || message.sender.id,
      },
      sourceFragments: message.fragments,
      interactionId: null,
      fragments: this.structuredGroupCommandMentions(message.chatType, fragments),
    });
  }

  private structuredGroupCommandMentions(
    chatType: NormalizedInboundMessage["chatType"],
    fragments: Fragment[],
  ): Fragment[] {
    const agentUserId = this.options.agentUserId;
    if (chatType !== "group" || !agentUserId) return fragments;
    return fragments.flatMap((fragment) => {
      const fragmentText = (fragment as Record<string, unknown>).text;
      if (fragment.kind !== "text" || typeof fragmentText !== "string") return [fragment];
      const parts = fragmentText.split("@Agent ");
      if (parts.length === 1) return [fragment];
      const structured: Fragment[] = [];
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          structured.push({
            kind: "mention",
            user_id: agentUserId,
            ...(this.options.agentDisplayName ? { display: this.options.agentDisplayName } : {}),
          });
        }
        const text = index > 0 ? ` ${part}` : part;
        if (text) structured.push({ kind: "text", text });
      }
      return structured;
    });
  }

  private async withResolvedSenderDisplayName(message: NormalizedInboundMessage): Promise<NormalizedInboundMessage> {
    const sender = await this.resolvedSender(message.sender);
    return sender === message.sender ? message : { ...message, sender };
  }

  private async resolvedSender(sender: Sender): Promise<Sender> {
    const current = sender.nick_name.trim();
    if (current && current !== sender.id) return sender;
    const displayName = await this.options.resolveSenderDisplayName?.(sender.id).catch(() => null);
    return displayName && displayName !== sender.id ? { ...sender, nick_name: displayName } : sender;
  }

  private async resolvedResponder(sender: Sender): Promise<{ id: string; displayName: string }> {
    const resolved = await this.resolvedSender(sender);
    return { id: resolved.id, displayName: resolved.nick_name || resolved.id };
  }

  private async acknowledgeAnswer(
    pending: PendingClawChatInteraction,
    question: RuntimeInteractionQuestion,
    sender: { id: string; nick_name: string },
    selectedLabel: string | null,
  ): Promise<void> {
    if (pending.route.chatType !== "group") return;
    const displayName = presentationText(sender.nick_name || sender.id, "Participant", 80);
    pending.lastAnswerResponder = { id: sender.id, displayName };
    if (pending.request.kind === "user-input" && pending.questionIndex >= pending.request.questions.length) return;
    const header = questionPresentationHeader(pending, question);
    const optionIndex =
      selectedLabel && pending.request.kind === "user-input"
        ? (pending.request.questions.find((candidate) => candidate === question)?.options ?? []).findIndex(
            (option) => option.label === selectedLabel,
          )
        : -1;
    const text = selectedLabel
      ? `${displayName} submitted “Option ${optionIndex + 1}” for ${header} in Session ${pending.sessionRef}.`
      : `${displayName} submitted an answer for ${header} in Session ${pending.sessionRef}.`;
    this.recordTerminal(pending, "question", text, sender.id);
    await this.send(pending, [
      {
        kind: "text",
        text,
      },
    ]);
  }

  private async settle(
    pending: PendingClawChatInteraction,
    response: RuntimeInteractionResponse,
    responder?: { id: string; displayName: string },
  ): Promise<void> {
    try {
      const claimed = await pending.settlement.claim(response, async (validated) => {
        if (validated.kind === "approval" && pending.timeout) {
          clearTimeout(pending.timeout);
          pending.timeout = null;
        }
        const displayName = responder ? presentationText(responder.displayName, "Participant", 80) : null;
        const decision =
          validated.kind === "approval"
            ? {
                "approve-once": { submitted: "approve once", confirmed: "approved once" },
                "approve-session": {
                  submitted: "approve for the Session",
                  confirmed: "approved for the Session",
                },
                deny: { submitted: "deny", confirmed: "denied" },
                cancel: { submitted: "cancel", confirmed: "cancelled" },
              }[validated.optionId]
            : null;
        const acceptedText =
          pending.route.chatType === "group" && displayName && decision
            ? `${displayName} ${decision.confirmed} for Session ${pending.sessionRef}.`
            : pending.route.chatType === "group" && validated.kind === "user-input" && pending.lastAnswerResponder
              ? `${pending.lastAnswerResponder.displayName}'s answers were delivered for Session ${pending.sessionRef}.`
              : null;
        if (pending.route.chatType === "group" && displayName && decision) {
          this.recordTerminal(
            pending,
            "approval",
            `${displayName} submitted “${decision.submitted}” for Session ${pending.sessionRef}; waiting for Runtime confirmation.`,
            responder?.id ?? null,
          );
        }
        if (pending.route.chatType === "group" && validated.kind === "user-input" && pending.lastAnswerResponder) {
          this.recordTerminal(
            pending,
            "question",
            `${pending.lastAnswerResponder.displayName} submitted answers for Session ${pending.sessionRef}; waiting for Runtime confirmation.`,
            pending.lastAnswerResponder.id,
          );
        }
        pending.resolve(validated);
        await pending.deliveryConfirmation;
        this.finishPending(pending);
        if (acceptedText) {
          this.recordTerminal(
            pending,
            validated.kind === "approval" ? "approval" : "question",
            acceptedText,
            validated.kind === "approval" ? (responder?.id ?? null) : (pending.lastAnswerResponder?.id ?? null),
          );
          await this.send(pending, [{ kind: "text", text: acceptedText }]);
        }
      });
      if (!claimed && pending.route.chatType === "group") {
        const kind = pending.request.kind === "approval" ? "approval" : "question";
        const terminal = this.terminalResponses.get(routeResponseKey(pending.route, kind));
        if (terminal) await this.send(pending, [{ kind: "text", text: terminal }]);
      }
    } catch {
      this.finishPending(pending);
      if (pending.route.chatType === "group") {
        const text = `Session ${pending.sessionRef} failed: Runtime response delivery was not confirmed.`;
        this.recordTerminal(
          pending,
          pending.request.kind === "approval" ? "approval" : "question",
          text,
          pending.request.kind === "approval" ? (responder?.id ?? null) : (pending.lastAnswerResponder?.id ?? null),
        );
        await this.send(pending, [{ kind: "text", text }]).catch(() => undefined);
      }
    }
  }

  private async expireApproval(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending?.request.kind !== "approval") return;
    pending.timeout = null;
    await this.settle(pending, { kind: "approval", optionId: "deny" });
    if (pending.settlement.terminalState() !== "resolved") return;
    const minutes = Math.max(1, Math.round((this.options.approvalDeadlineMs ?? APPROVAL_DEADLINE_MS) / 60_000));
    const text = `${groupSessionPrefix(pending)}审批请求已超过 ${minutes} 分钟未处理，已自动拒绝，当前回合将继续。`;
    this.recordTerminal(pending, "approval", text);
    await this.send(pending, [{ kind: "text", text }]).catch(() => undefined);
  }

  private async cancel(id: string, reason: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (!pending.settlement.expire()) return;
    this.pending.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbortListener();
    try {
      if (pending.route.chatType === "group") {
        const state = /deadline|expired/iu.test(reason) ? "expired" : "cancelled";
        const text = `Session ${pending.sessionRef} ${state}: ${reason}.`;
        this.recordTerminal(pending, pending.request.kind === "approval" ? "approval" : "question", text);
        await this.send(pending, [
          {
            kind: "text",
            text,
          },
        ]);
      }
    } finally {
      pending.reject(new Error(reason));
    }
  }

  private recordTerminal(
    pending: PendingClawChatInteraction,
    kind: "approval" | "question",
    text: string,
    responderId: string | null = null,
  ): void {
    this.terminalResponses.set(routeResponseKey(pending.route, kind), text);
    this.terminalInteractions.set(pending.id, {
      route: { chatId: pending.route.chatId, chatType: pending.route.chatType },
      responderId,
      text,
    });
    if (this.terminalResponses.size > 100) {
      const oldest = this.terminalResponses.keys().next().value;
      if (oldest) this.terminalResponses.delete(oldest);
    }
    if (this.terminalInteractions.size > 100) {
      const oldest = this.terminalInteractions.keys().next().value;
      if (oldest) this.terminalInteractions.delete(oldest);
    }
  }

  private finishPending(pending: PendingClawChatInteraction): void {
    this.pending.delete(pending.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbortListener();
  }
}

function requiresOrderedControl(text: string, senderId: string, ownerUserId: string): boolean {
  return senderId === ownerUserId && requiresOrderedSessionControl(text);
}

function pendingInteractionHint(
  pending: PendingClawChatInteraction,
  chatType: NormalizedInboundMessage["chatType"],
): string {
  const prefix = commandAddressPrefix(chatType);
  const session = chatType === "group" ? `（Session ${pending.sessionRef}）` : "";
  const resend = "这条消息未被处理，请在回复后重新发送。";
  if (pending.request.kind === "approval") {
    const what = pending.request.action === "file-change" ? "文件修改审批" : "命令审批";
    return `当前有一个${what}${session}正在等待回复，这条消息未被处理，请先回复：\n${prefix}/approve 仅此次允许\n${prefix}/approve session 本 Session 允许\n${prefix}/deny 拒绝\n${prefix}/cancel 取消当前回合\n回复后请重新发送这条消息。`;
  }
  const question = pending.request.questions[pending.questionIndex];
  const answers = [
    ...(question?.options?.length ? [`${prefix}/N 选择对应选项`] : []),
    ...(!question?.options?.length || question.allowOther ? [`${prefix}/answer <答案> 提交答案`] : []),
  ];
  return `当前有一个问题${session}正在等待回答，请先回答：\n${answers.join("\n")}\n${prefix}/cancel 取消当前回合\n${resend}`;
}

function approvalOptionId(text: string): "approve-once" | "approve-session" | "deny" | null {
  if (/[\r\n]/u.test(text)) return null;
  const command = text.trim().replace(/[ \t]+/gu, " ");
  if (command === "/approve") return "approve-once";
  if (command === "/approve session") return "approve-session";
  if (command === "/deny") return "deny";
  return null;
}

function runtimeResponseKind(text: string): "approval" | "answer" | "number" | null {
  const token =
    text
      .trim()
      .split(/[ \t\r\n]+/u)[0]
      ?.toLowerCase() ?? "";
  if (token === "/approve" || token === "/deny") return "approval";
  if (token === "/answer") return "answer";
  if (/^\/\d/u.test(token)) return "number";
  return null;
}

function runtimeResponseUsage(
  chatType: NormalizedInboundMessage["chatType"],
  kind: "approval" | "answer" | "number",
): string {
  const prefix = commandAddressPrefix(chatType);
  if (kind === "approval") return `Usage: ${prefix}/approve | ${prefix}/approve session | ${prefix}/deny`;
  if (kind === "answer") return `Usage: ${prefix}/answer <text>`;
  return `Usage: ${prefix}/N`;
}

function groupSessionPrefix(pending: PendingClawChatInteraction): string {
  return pending.route.chatType === "group" ? `Session ${pending.sessionRef}\n` : "";
}

function questionPresentationHeader(
  pending: PendingClawChatInteraction,
  question?: RuntimeInteractionQuestion,
): string {
  const current =
    question ?? (pending.request.kind === "user-input" ? pending.request.questions[pending.questionIndex] : undefined);
  if (pending.route.chatType !== "group") return presentationText(current?.header ?? "", "Question", 80);
  const index =
    pending.request.kind === "user-input" && current
      ? pending.request.questions.indexOf(current)
      : pending.questionIndex;
  return `Question ${Math.max(0, index) + 1}`;
}

function routeResponseKey(
  route: Pick<ClawChatInteractionRoute, "chatId" | "chatType">,
  kind: "approval" | "question",
): string {
  return `${route.chatType}\u0000${route.chatId}\u0000${kind}`;
}

function presentationText(value: string, fallback: string, maxLength: number): string {
  const withoutControlCharacters = [...value.normalize("NFKC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("");
  const normalized = withoutControlCharacters.replace(/\s+/gu, " ").trim();
  if (!normalized) return fallback;
  if (
    [
      /\b(api[-_ ]?key|authorization|bearer|password|secret|token)\b\s*[:=]\s*\S+/iu,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
      /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/u,
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
      /https?:\/\/\S+\?\S+/iu,
      /\b[A-Za-z0-9_+/=-]{32,}\b/u,
    ].some((pattern) => pattern.test(normalized))
  ) {
    return fallback;
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function numberedOption<T>(text: string, options: T[] | null): T | null {
  if (!options) return null;
  const match = /^\/([1-9]\d*)$/u.exec(text.trim());
  const index = Number(match?.[1] ?? 0) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? (options[index] ?? null) : null;
}

function freeTextAnswer(text: string): string | null {
  const match = /^\/answer[ \t]+([^\r\n]+)$/u.exec(text.trim());
  return match?.[1]?.trim() || null;
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
