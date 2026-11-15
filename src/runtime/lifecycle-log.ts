import type { NormalizedInboundMessage } from "../clawchat/protocol";

/**
 * Message lifecycle log (matrix O-08, format v1): one `clawchat-lifecycle {json}` line per step on container stdout.
 * Lines carry ids, a fixed reason code and an optional redacted error class/code. They never carry message text,
 * attachment names, prompts, model output or tool arguments: nothing here accepts such content.
 */
export const LIFECYCLE_PREFIX = "clawchat-lifecycle ";

export const IGNORED_REASONS = [
  "not_addressed",
  "not_owner",
  "muted",
  "oversized",
  "empty_message",
  "command",
  "interaction_response",
  "pending_interaction",
  "no_turn",
] as const;
export const QUEUED_REASONS = ["busy"] as const;
export const FAILED_REASONS = [
  "send_failed",
  "model_error",
  "timeout",
  "cancelled",
  "bridge_exit",
  "restart",
  "recovery_gave_up",
  "runtime_error",
] as const;
export const EXPIRED_REASONS = ["timeout"] as const;
export type IgnoredReason = (typeof IGNORED_REASONS)[number];
export type QueuedReason = (typeof QUEUED_REASONS)[number];
export type FailedReason = (typeof FAILED_REASONS)[number];
export type ExpiredReason = (typeof EXPIRED_REASONS)[number];
export type LifecycleReason = IgnoredReason | QueuedReason | FailedReason | ExpiredReason;
export const LIFECYCLE_REASONS: readonly LifecycleReason[] = [
  ...IGNORED_REASONS,
  ...QUEUED_REASONS,
  ...FAILED_REASONS,
  ...EXPIRED_REASONS,
];

/** A step with the fields only it may carry; `reason` is required exactly where the format requires it. */
export type LifecycleStepFields =
  | { step: "received" }
  | { step: "ignored"; reason: IgnoredReason }
  | { step: "queued"; reason: QueuedReason }
  | { step: "turn_started"; turn: string }
  | { step: "reply_sent"; turn?: string; reply?: string }
  | { step: "turn_finished"; turn: string }
  | { step: "turn_failed"; turn?: string; reason: FailedReason; error?: string }
  | { step: "interaction_pending"; turn: string }
  | { step: "interaction_expired"; turn: string; reason: ExpiredReason };

export interface LifecycleFailure {
  reason: FailedReason;
  error?: string;
}

/** Once-only memory for "this message id was received / ended"; backed by the state store in production. */
export interface LifecycleLedger {
  claim(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
}

class MemoryLedger implements LifecycleLedger {
  private readonly keys = new Set<string>();
  async claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
  async has(key: string): Promise<boolean> {
    return this.keys.has(key);
  }
}

/** Unreachable under the types; a line that arrives with an unknown reason is written with its step's fallback. */
const STEP_REASONS: Record<
  "ignored" | "queued" | "turn_failed" | "interaction_expired",
  {
    allowed: ReadonlySet<string>;
    fallback: LifecycleReason;
  }
> = {
  ignored: { allowed: new Set(IGNORED_REASONS), fallback: "no_turn" },
  queued: { allowed: new Set(QUEUED_REASONS), fallback: "busy" },
  turn_failed: { allowed: new Set(FAILED_REASONS), fallback: "runtime_error" },
  interaction_expired: { allowed: new Set(EXPIRED_REASONS), fallback: "timeout" },
};
const MAX_FIELD_CHARACTERS = 200;

export interface LifecycleMessageRef {
  messageId: string;
  chatId: string;
}

interface LifecycleLogOptions {
  /** Runtime label, or a function resolving it; no label means no lines. Defaults to "dsh". */
  runtime?: string | (() => string | undefined);
  /** Makes received/terminal lines once-only across restarts. Defaults to process memory. */
  ledger?: LifecycleLedger;
  /** Receives one finished line without a trailing newline. Defaults to container stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

/** Every inbound ClawChat message id a Turn answers: the batch members, or the message itself. */
export function lifecycleMessageIds(message: NormalizedInboundMessage): string[] {
  const batch = message.groupBatch?.messages.map((entry) => entry.message_id);
  return batch && batch.length > 0 ? batch : [message.messageId];
}

/** A failure that already knows the reason code its Turn failure is logged under. */
export class LifecycleError extends Error {
  readonly reason: FailedReason;
  constructor(message: string, reason: FailedReason, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.reason = reason;
  }
}

/** The Runtime process or its bridge died or broke protocol; the Turn will never finish. */
export class BridgeExitError extends LifecycleError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "bridge_exit", options);
  }
}

/** A Runtime request did not answer in time. */
export class BridgeTimeoutError extends LifecycleError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "timeout", options);
  }
}

/** A reply could not be handed to ClawChat or the server rejected it. Carries the original error as `cause`. */
export class ReplySendError extends LifecycleError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "send_failed", options);
  }
}

/**
 * Connect itself is shutting the Runtime down. Not a failure of the message: nothing is logged and no failure notice
 * is sent; a restart recovers the message.
 */
export class ShutdownError extends Error {
  override name = "ShutdownError";
}

/** Reason code and error class/code for a failure. The error message is never used. */
export function classifyFailure(error: unknown): LifecycleFailure {
  if (error instanceof LifecycleError) {
    const name = errorClass(error.cause) ?? errorClass(error);
    return { reason: error.reason, ...(name ? { error: name } : {}) };
  }
  const name = errorClass(error);
  if (name === "AbortError") return { reason: "cancelled", error: name };
  return { reason: "runtime_error", ...(name ? { error: name } : {}) };
}

/** Error class or code only: bounded, restricted to an identifier alphabet, credential-looking runs removed. */
export function redactLifecycleError(value: unknown): string | undefined {
  return errorClass(value);
}

function errorClass(value: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof value === "string") raw = value;
  else if (value && typeof value === "object") {
    const record = value as { code?: unknown; name?: unknown };
    if (typeof record.code === "string" && record.code) raw = record.code;
    else if (typeof record.name === "string" && record.name) raw = record.name;
  }
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/(bearer|basic)\s+\S+/giu, "$1 [redacted]")
    .replace(/(?:sk|dsh|tok|key|secret|pat|ghp)[-_][A-Za-z0-9_-]{8,}/giu, "[redacted]")
    .replace(/(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{24,}/gu, "[redacted]")
    .replace(/[^A-Za-z0-9_.:[\] -]/gu, "")
    .slice(0, MAX_FIELD_CHARACTERS);
  return cleaned || undefined;
}

function boundedId(value: string): string {
  return value.slice(0, MAX_FIELD_CHARACTERS);
}

/**
 * Formats and writes lifecycle lines. Per message id it writes exactly one `received` and at most one terminal line
 * (ignored / turn_finished / turn_failed), for the life of the ledger: a redelivered id logs nothing, retries log
 * nothing, and no step is written after the terminal line. Calls return at once; lines are written in call order.
 */
export class LifecycleLog {
  private readonly runtime: () => string | undefined;
  private readonly writeLine: (line: string) => void;
  private readonly now: () => Date;
  private readonly ledger: LifecycleLedger;
  private readonly seen = new Set<string>();
  private readonly started = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(options: LifecycleLogOptions = {}) {
    const runtime = options.runtime ?? "dsh";
    this.runtime = typeof runtime === "function" ? runtime : () => runtime;
    this.writeLine =
      options.write ??
      ((line) => {
        process.stdout.write(`${line}\n`);
      });
    this.now = options.now ?? (() => new Date());
    this.ledger = options.ledger ?? new MemoryLedger();
  }

  /** A log that writes nothing, for components constructed without a Binding Runtime around them. */
  static silent(): LifecycleLog {
    const log = new LifecycleLog({ write: () => undefined });
    log.active = false;
    return log;
  }

  /** False for a silent log, so callers can skip work that only feeds the log. */
  active = true;

  /** True once this process has seen the message id; used to tell a restart's leftovers from in-flight work. */
  seenInProcess(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  received(message: LifecycleMessageRef): void {
    this.seen.add(message.messageId);
    this.record(message.messageId, message.chatId, { step: "received" }, false);
  }

  ignored(ids: readonly string[], chat: string, reason: IgnoredReason): void {
    for (const msg of ids) this.record(msg, chat, { step: "ignored", reason }, true);
  }

  queued(ids: readonly string[], chat: string, reason: QueuedReason): void {
    for (const msg of ids) this.record(msg, chat, { step: "queued", reason }, false);
  }

  turnStarted(ids: readonly string[], turn: string, chat: string): void {
    for (const msg of ids) {
      // Once per message: a Runtime may report the first interaction before the input is acknowledged.
      if (this.started.has(msg)) continue;
      this.started.add(msg);
      this.record(msg, chat, { step: "turn_started", turn }, false);
    }
  }

  /** `at` is when the reply was handed to ClawChat; `reply` only when the outbound id is known at that time. */
  replySent(message: LifecycleMessageRef, fields: { turn?: string; reply?: string; at: Date }): void {
    this.record(
      message.messageId,
      message.chatId,
      {
        step: "reply_sent",
        ...(fields.turn ? { turn: fields.turn } : {}),
        ...(fields.reply ? { reply: fields.reply } : {}),
      },
      false,
      fields.at,
    );
  }

  turnFinished(ids: readonly string[], turn: string, chat: string): void {
    for (const msg of ids) this.record(msg, chat, { step: "turn_finished", turn }, true);
  }

  turnFailed(ids: readonly string[], turn: string | undefined, chat: string, failure: LifecycleFailure): void {
    for (const msg of ids) {
      this.seen.add(msg);
      this.record(
        msg,
        chat,
        {
          step: "turn_failed",
          ...(turn ? { turn } : {}),
          reason: failure.reason,
          ...(failure.error ? { error: failure.error } : {}),
        },
        true,
      );
    }
  }

  interactionPending(msg: string, turn: string, chat: string): void {
    this.turnStarted([msg], turn, chat);
    this.record(msg, chat, { step: "interaction_pending", turn }, false);
  }

  interactionExpired(msg: string, turn: string, chat: string): void {
    this.record(msg, chat, { step: "interaction_expired", turn, reason: "timeout" }, false);
  }

  private record(msg: string, chat: string, fields: LifecycleStepFields, terminal: boolean, at?: Date): void {
    const ts = (at ?? this.now()).toISOString();
    const task = async () => {
      let label: string | undefined;
      try {
        label = this.runtime();
      } catch {
        label = undefined;
      }
      if (!label) return;
      const receivedKey = `lifecycle:received:${msg}`;
      const terminalKey = `lifecycle:terminal:${msg}`;
      if (fields.step === "received") {
        if (await this.ledger.claim(receivedKey)) this.write(label, ts, msg, chat, fields);
        return;
      }
      // A step for an id whose `received` was never written (older process, replay) gets its received line first.
      if (await this.ledger.claim(receivedKey)) this.write(label, ts, msg, chat, { step: "received" });
      if (terminal) {
        if (await this.ledger.claim(terminalKey)) this.write(label, ts, msg, chat, fields);
      } else if (!(await this.ledger.has(terminalKey))) {
        this.write(label, ts, msg, chat, fields);
      }
    };
    this.tail = this.tail.then(task).catch(() => undefined);
  }

  /** Resolves when every line recorded so far has been written. */
  async flush(): Promise<void> {
    await this.tail;
  }

  private write(runtime: string, ts: string, msg: string, chat: string, fields: LifecycleStepFields): void {
    const extra = fields as { turn?: string; reply?: string; reason?: LifecycleReason; error?: string };
    let reason = extra.reason;
    if (
      reason !== undefined &&
      (fields.step === "ignored" ||
        fields.step === "queued" ||
        fields.step === "turn_failed" ||
        fields.step === "interaction_expired")
    ) {
      const rule = STEP_REASONS[fields.step];
      if (!rule.allowed.has(reason)) reason = rule.fallback;
    }
    const record = {
      v: 1,
      ts,
      runtime,
      step: fields.step,
      msg: boundedId(msg),
      ...(extra.reply ? { reply: boundedId(extra.reply) } : {}),
      ...(extra.turn ? { turn: boundedId(extra.turn) } : {}),
      chat: boundedId(chat),
      ...(reason ? { reason } : {}),
      ...(extra.error ? { error: redactLifecycleError(extra.error) } : {}),
    };
    try {
      this.writeLine(`${LIFECYCLE_PREFIX}${JSON.stringify(record)}`);
    } catch {
      // Logging must never fail a message.
    }
  }
}
