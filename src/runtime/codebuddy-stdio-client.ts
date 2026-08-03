import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ConnectRuntimePrompt, ConnectRuntimeSession, RuntimeActivity, RuntimeInteractionRequest } from "./types";
import { type WorkBuddyProfile, workBuddyProfileCompatibility } from "./workbuddy-task-discovery";

export interface CodeBuddyStdioSessionInput {
  profile: WorkBuddyProfile;
  sessionId: string | null;
  onSessionId(sessionId: string): Promise<void>;
}

interface ActiveCodeBuddyConnection {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  sessionId: string;
}

export async function createCodeBuddyStdioSession(input: CodeBuddyStdioSessionInput): Promise<ConnectRuntimeSession> {
  return new CodeBuddyStdioSession(input);
}

class CodeBuddyStdioSession implements ConnectRuntimeSession {
  private active: ActiveCodeBuddyConnection | null = null;
  private operation: CodeBuddyPromptOperation | null = null;
  private closed = false;
  private nextTurn = 0;

  constructor(private readonly input: CodeBuddyStdioSessionInput) {}

  async *prompt(prompt: ConnectRuntimePrompt): AsyncIterable<RuntimeActivity> {
    if (this.closed) throw new Error("CodeBuddy Session is closed");
    if (this.operation) throw new Error("CodeBuddy Session already has an active turn");
    const active = await this.ensureActive(prompt);
    const operation = new CodeBuddyPromptOperation(this.nextTurn++, active.connection, active.sessionId, prompt);
    this.operation = operation;
    try {
      for await (const activity of operation.run()) yield activity;
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  async cancel(): Promise<boolean> {
    const operation = this.operation;
    if (!operation) return false;
    await operation.cancel();
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.operation?.cancel().catch(() => undefined);
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => active.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (active.child.exitCode === null) active.child.kill("SIGKILL");
  }

  private async ensureActive(prompt: ConnectRuntimePrompt): Promise<ActiveCodeBuddyConnection> {
    if (this.active) return this.active;
    const compatibility = workBuddyProfileCompatibility(this.input.profile);
    const executable = join(
      compatibility.applicationPath,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "cli",
      "bin",
      "codebuddy",
    );
    const child = spawn(executable, ["--acp"], {
      cwd: prompt.workspace.workingDirectory,
      env: {
        ...process.env,
        DISABLE_AUTOUPDATER: "1",
        CODEBUDDY_DISABLE_IDE: "1",
        CODEBUDDY_CONFIG_DIR: compatibility.configDirectory,
        WORKBUDDY_CONFIG_DIR: compatibility.configDirectory,
        WORKBUDDY_APP_PATH: compatibility.applicationPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
      while (stderr.join("").length > 8_192) stderr.shift();
    });
    const handler = new CodeBuddyClientHandler(() => this.operation);
    const connection = new ClientSideConnection(
      () => handler,
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    try {
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "clawchat-connect", version: "1" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`CodeBuddy negotiated unsupported ACP protocol ${initialized.protocolVersion}`);
      }
      const sessionRequest = {
        cwd: prompt.workspace.workingDirectory,
        additionalDirectories: prompt.workspace.additionalDirectories,
        mcpServers: [],
      };
      const sessionId = this.input.sessionId;
      if (sessionId) {
        await connection.loadSession({ ...sessionRequest, sessionId });
      } else {
        const created = await connection.newSession(sessionRequest);
        await this.input.onSessionId(created.sessionId);
        this.input.sessionId = created.sessionId;
      }
      const active = { child, connection, sessionId: this.input.sessionId as string };
      this.active = active;
      return active;
    } catch (error) {
      child.kill("SIGTERM");
      const detail = boundedStderr(stderr.join(""));
      throw new Error(`CodeBuddy ACP startup failed${detail ? `: ${detail}` : ""}`, { cause: error });
    }
  }
}

class CodeBuddyClientHandler implements Client {
  constructor(private readonly activeOperation: () => CodeBuddyPromptOperation | null) {}

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    await this.activeOperation()?.observe(notification);
  }

  async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const operation = this.activeOperation();
    if (!operation) return { outcome: { outcome: "cancelled" } };
    return await operation.requestPermission(request);
  }
}

class CodeBuddyPromptOperation {
  private readonly queue = new AsyncActivityQueue();
  private readonly projector: CodeBuddyActivityProjector;
  private accepted = false;
  private settled = false;

  constructor(
    turn: number,
    private readonly connection: ClientSideConnection,
    private readonly sessionId: string,
    private readonly input: ConnectRuntimePrompt,
  ) {
    this.projector = new CodeBuddyActivityProjector(turn);
  }

  run(): AsyncIterable<RuntimeActivity> {
    void this.submit();
    return this.queue;
  }

  async observe(notification: SessionNotification): Promise<void> {
    if (notification.sessionId !== this.sessionId || this.settled) return;
    await this.accept();
    for (const activity of this.projector.observe(notification)) this.queue.push(activity);
  }

  async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (request.sessionId !== this.sessionId || this.settled) return { outcome: { outcome: "cancelled" } };
    const port = this.input.interactionPort;
    const sessionRef = this.input.metadata?.sessionRef;
    if (!port || !sessionRef || !this.input.turnId || !this.input.turnOrigin) {
      return { outcome: { outcome: "cancelled" } };
    }
    const mappedOptions = request.options.map((option) => ({
      nativeId: option.optionId,
      optionId:
        option.kind === "allow_once"
          ? ("approve-once" as const)
          : option.kind === "allow_always"
            ? ("approve-session" as const)
            : ("deny" as const),
      label: option.name,
    }));
    const interaction: RuntimeInteractionRequest = {
      kind: "approval",
      action: request.toolCall.kind === "edit" ? "file-change" : "command",
      title: request.toolCall.title ?? "CodeBuddy permission request",
      description: request.toolCall.title ?? "CodeBuddy requests permission to continue.",
      cwd: this.input.workspace.workingDirectory,
      options: mappedOptions.map(({ optionId, label }) => ({ id: optionId, label })),
    };
    const response = await port.request(interaction, {
      sessionRef,
      turnId: this.input.turnId,
      origin: this.input.turnOrigin,
      deliveryConfirmation: Promise.resolve(),
    });
    if (response.kind !== "approval" || response.optionId === "cancel") {
      return { outcome: { outcome: "cancelled" } };
    }
    const selected = mappedOptions.find((option) => option.optionId === response.optionId);
    return selected
      ? { outcome: { outcome: "selected", optionId: selected.nativeId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  private async submit(): Promise<void> {
    try {
      const result = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: this.input.prompt }],
      });
      await this.accept();
      for (const activity of this.projector.complete(result.stopReason)) this.queue.push(activity);
      this.settled = true;
      this.queue.close();
    } catch (error) {
      this.settled = true;
      this.queue.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async accept(): Promise<void> {
    if (this.accepted) return;
    this.accepted = true;
    await this.input.onAccepted?.();
  }
}

class CodeBuddyActivityProjector {
  private readonly activities = new Map<string, RuntimeActivity>();
  private readonly activityNamespace = randomUUID();
  private nextItem = 0;

  constructor(private readonly turn: number) {}

  observe(notification: SessionNotification): RuntimeActivity[] {
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (!text) return [];
      const kind = update.sessionUpdate === "agent_message_chunk" ? "assistant" : "reasoning";
      const nativeId = update.messageId ?? kind;
      return [this.upsert(`${kind}:${nativeId}`, kind, text, "streaming", true)];
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const key = `tool:${update.toolCallId}`;
      const previous = this.activities.get(key);
      const title = update.title ?? previous?.text ?? "CodeBuddy tool activity";
      return [this.upsert(key, "tool", title, toolState(update.status), false)];
    }
    if (update.sessionUpdate === "plan") {
      return [this.upsert("plan:current", "plan", JSON.stringify(update.entries), "streaming", false)];
    }
    return [];
  }

  complete(stopReason: string): RuntimeActivity[] {
    const state: RuntimeActivity["state"] = stopReason === "cancelled" ? "cancelled" : "complete";
    const completed: RuntimeActivity[] = [];
    for (const [key, activity] of this.activities) {
      if (activity.state === "complete" || activity.state === "error" || activity.state === "cancelled") continue;
      const next = { ...activity, state };
      this.activities.set(key, next);
      completed.push(next);
    }
    return completed;
  }

  private upsert(
    key: string,
    kind: RuntimeActivity["kind"],
    text: string,
    state: RuntimeActivity["state"],
    append: boolean,
  ): RuntimeActivity {
    const previous = this.activities.get(key);
    const activity: RuntimeActivity = {
      id: previous?.id ?? `codebuddy:${this.activityNamespace}:${key}`,
      position: previous?.position ?? `${this.turn}.${this.nextItem++}`,
      parentId: null,
      kind,
      text: append ? `${previous?.text ?? ""}${text}` : text,
      state,
      source: "live",
    };
    this.activities.set(key, activity);
    return activity;
  }
}

class AsyncActivityQueue implements AsyncIterable<RuntimeActivity> {
  private readonly values: RuntimeActivity[] = [];
  private readonly waiters: Array<{
    resolve(result: IteratorResult<RuntimeActivity>): void;
    reject(error: Error): void;
  }> = [];
  private ended = false;
  private error: Error | null = null;

  push(value: RuntimeActivity): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeActivity> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.error) throw this.error;
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<RuntimeActivity>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function contentText(content: SessionNotification["update"] extends infer _Update ? unknown : never): string {
  if (!content || typeof content !== "object") return "";
  const value = content as { type?: unknown; text?: unknown };
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function toolState(status: unknown): RuntimeActivity["state"] {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  return "streaming";
}

function boundedStderr(stderr: string): string {
  return stderr.replace(/\s+/gu, " ").trim().slice(0, 1_000);
}
