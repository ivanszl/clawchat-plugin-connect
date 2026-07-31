import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Agent,
  GlobalEvent,
  Message,
  Part,
  PermissionRequest,
  Provider,
  QuestionInfo,
  QuestionRequest,
  Session,
  ToolPart,
} from "@opencode-ai/sdk/v2/types";
import type { AgentBindingConfig, OpenCodeAgentBindingConfig } from "../types";
import { createOpenCodeServerClient, type OpenCodeMessage, type OpenCodeServerClient } from "./opencode-server";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
  RuntimeActivity,
  RuntimeActivitySnapshot,
  RuntimeModelOption,
  RuntimeSessionOption,
} from "./types";

export interface OpenCodeRuntimeAdapterOptions {
  createServer?: (binding: OpenCodeAgentBindingConfig) => Promise<OpenCodeServerClient>;
  messageID?: () => string;
}

type EventListener = (event: GlobalEvent | Error) => Promise<void> | void;

export function createOpenCodeRuntimeAdapter(options: OpenCodeRuntimeAdapterOptions = {}): ConnectRuntimeAdapter {
  let clientPromise: Promise<OpenCodeServerClient> | null = null;
  let eventsAbort: AbortController | null = null;
  let eventsPump: Promise<void> | null = null;
  let closed = false;
  let lastDirectory = tmpdir();
  const listeners = new Set<EventListener>();
  const threadDirectories = new Map<string, string>();

  const clientFor = async (binding: AgentBindingConfig): Promise<OpenCodeServerClient> => {
    const openCodeBinding = requireOpenCodeBinding(binding);
    if (closed) throw new Error("OpenCode Runtime Adapter is closed");
    if (!clientPromise) {
      const starting = (options.createServer ?? createOpenCodeServerClient)(openCodeBinding);
      clientPromise = starting;
      let client: OpenCodeServerClient;
      try {
        client = await starting;
      } catch (error) {
        if (clientPromise === starting) clientPromise = null;
        throw error;
      }
      eventsAbort = new AbortController();
      let settleReady!: () => void;
      let rejectReady!: (error: Error) => void;
      let readySettled = false;
      const ready = new Promise<void>((resolve, reject) => {
        settleReady = resolve;
        rejectReady = reject;
      });
      eventsPump = pumpEvents(
        client,
        eventsAbort.signal,
        listeners,
        () => {
          readySettled = true;
          settleReady();
        },
        async (failure) => {
          if (!readySettled) rejectReady(failure);
          await client.close().catch(() => undefined);
          if (clientPromise === starting) clientPromise = null;
          eventsAbort = null;
          eventsPump = null;
        },
      );
      try {
        await withTimeout(ready, 10_000, "OpenCode global event stream did not connect");
      } catch (error) {
        eventsAbort.abort();
        await client.close().catch(() => undefined);
        if (clientPromise === starting) clientPromise = null;
        throw error;
      }
    }
    return await clientPromise;
  };

  const locateSession = async (
    binding: AgentBindingConfig,
    runtimeThreadId: string,
  ): Promise<{ client: OpenCodeServerClient; session: Session }> => {
    const client = await clientFor(binding);
    const knownDirectory = threadDirectories.get(runtimeThreadId);
    if (knownDirectory) return { client, session: await client.getSession(runtimeThreadId, knownDirectory) };
    const session = (await client.listSessions()).find((candidate) => candidate.id === runtimeThreadId);
    if (!session) throw new Error(`OpenCode Session was not found: ${runtimeThreadId}`);
    threadDirectories.set(session.id, session.directory);
    return { client, session };
  };

  return {
    kind: "opencode",
    modes: [],
    lifecycleCapabilities: { archive: false, restore: false, delete: true },
    async prepare(binding) {
      await clientFor(binding);
    },
    async listSessionOptions(binding, workspace) {
      lastDirectory = workspace.workingDirectory;
      const client = await clientFor(binding);
      const [agents, providers] = await Promise.all([
        client.listAgents(workspace.workingDirectory),
        client.listProviders(workspace.workingDirectory),
      ]);
      return sessionOptions(agents, providers);
    },
    async listModels(binding) {
      return modelOptions(await (await clientFor(binding)).listProviders(lastDirectory));
    },
    async discoverThreads(binding, workspace) {
      lastDirectory = workspace.workingDirectory;
      return summarizeSessions(
        (await (await clientFor(binding)).listSessions(workspace.workingDirectory)).filter(
          (session) => canonical(session.directory) === canonical(workspace.workingDirectory),
        ),
        threadDirectories,
      );
    },
    async discoverAllThreads(binding) {
      return summarizeSessions(await (await clientFor(binding)).listSessions(), threadDirectories);
    },
    async readActivity(binding, runtimeThreadId) {
      const { client, session } = await locateSession(binding, runtimeThreadId);
      return activitySnapshot(await client.messages(session.id, session.directory));
    },
    async deleteThread(binding, runtimeThreadId) {
      let located: { client: OpenCodeServerClient; session: Session };
      try {
        located = await locateSession(binding, runtimeThreadId);
      } catch (error) {
        if (error instanceof Error && /not found/iu.test(error.message)) return;
        throw error;
      }
      await located.client.deleteSession(located.session.id, located.session.directory);
      threadDirectories.delete(runtimeThreadId);
    },
    async start(binding, context) {
      return new OpenCodeRuntimeSession({
        client: await clientFor(binding),
        context,
        listeners,
        threadDirectories,
        messageID: options.messageID ?? randomUUID,
        onDirectory: (directory) => {
          lastDirectory = directory;
        },
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      eventsAbort?.abort();
      await eventsPump?.catch(() => undefined);
      if (clientPromise) await (await clientPromise).close();
      listeners.clear();
      clientPromise = null;
    },
  };
}

interface OpenCodeRuntimeSessionOptions {
  client: OpenCodeServerClient;
  context: ConnectRuntimeStartContext;
  listeners: Set<EventListener>;
  threadDirectories: Map<string, string>;
  messageID: () => string;
  onDirectory(directory: string): void;
}

class OpenCodeRuntimeSession implements ConnectRuntimeSession {
  private runtimeThreadId: string | null;
  private active: {
    directory: string;
    queue: ActivityQueue;
    listener: EventListener;
    pendingNativeRequests: Map<string, "permission" | "question">;
    trustedRoots: string[];
  } | null = null;
  private closed = false;

  constructor(private readonly options: OpenCodeRuntimeSessionOptions) {
    this.runtimeThreadId = options.context.runtimeSessionId;
  }

  async *prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeActivity> {
    if (this.closed) throw new Error("OpenCode Runtime Session is closed");
    if (this.active) throw new Error("OpenCode Runtime Session already has an active turn");
    const directory = canonical(input.workspace.workingDirectory);
    this.options.onDirectory(directory);
    const session = await this.ensureThread(directory);
    const statuses = await this.options.client.sessionStatus(directory);
    if (statuses[session.id]?.type === "busy") {
      throw new Error("OpenCode Session is busy in another client; wait for it to become idle and refresh");
    }
    await validatePromptSelection(this.options.client, input, directory);

    const queue = new ActivityQueue();
    const pendingNativeRequests = new Map<string, "permission" | "question">();
    const listener: EventListener = async (event) => {
      if (event instanceof Error) {
        queue.push(errorActivity(input.turnId, event));
        queue.close();
        return;
      }
      if (canonical(event.directory) !== directory) return;
      const payload = event.payload as { type: string; properties?: Record<string, unknown> };
      if (stringValue(payload.properties?.sessionID) !== session.id) return;
      if (payload.type === "permission.asked") {
        await this.handlePermission(payload.properties as unknown as PermissionRequest, input, pendingNativeRequests);
        return;
      }
      if (payload.type === "question.asked") {
        await this.handleQuestion(payload.properties as unknown as QuestionRequest, input, pendingNativeRequests);
        return;
      }
      if (payload.type === "session.error") {
        queue.push(errorActivity(input.turnId, new Error(nativeErrorText(payload.properties))));
        queue.close();
        return;
      }
      if (payload.type === "message.part.updated" || payload.type === "session.idle") {
        const snapshot = activitySnapshot(await this.options.client.messages(session.id, directory));
        for (const activity of snapshot.activities) queue.push({ ...activity, source: "live" });
      }
      if (payload.type === "session.idle") queue.close();
    };
    this.active = {
      directory,
      queue,
      listener,
      pendingNativeRequests,
      trustedRoots: [directory, ...input.workspace.additionalDirectories.map(canonical)],
    };
    this.options.listeners.add(listener);
    try {
      await this.options.client.promptAsync({
        sessionID: session.id,
        directory,
        messageID: this.options.messageID(),
        ...promptSelection(input),
        parts: promptParts(input),
      });
      await input.onAccepted?.();
      yield* queue;
    } catch (error) {
      if (!queue.isClosed) queue.fail(error);
      throw error;
    } finally {
      this.options.listeners.delete(listener);
      if (this.active?.queue === queue) this.active = null;
    }
  }

  async cancel(): Promise<boolean> {
    const active = this.active;
    if (!active || !this.runtimeThreadId) return false;
    for (const [requestID, kind] of active.pendingNativeRequests) {
      if (kind === "permission") {
        await this.options.client.replyPermission(requestID, active.directory, "reject").catch(() => false);
      } else {
        await this.options.client.rejectQuestion(requestID, active.directory).catch(() => false);
      }
      active.pendingNativeRequests.delete(requestID);
    }
    const aborted = await this.options.client.abortSession(this.runtimeThreadId, active.directory);
    active.queue.push({
      id: `turn:${this.options.context.sessionId}:cancelled`,
      position: "0.0",
      parentId: null,
      kind: "progress",
      text: "OpenCode turn cancelled.",
      state: "cancelled",
      source: "live",
    });
    active.queue.close();
    return aborted;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.cancel();
    this.closed = true;
  }

  private async ensureThread(directory: string): Promise<Session> {
    if (this.runtimeThreadId) {
      const session = await this.options.client.getSession(this.runtimeThreadId, directory);
      if (canonical(session.directory) !== directory) {
        throw new Error(
          `OpenCode Session directory conflict: expected ${directory}, native Session uses ${canonical(session.directory)}`,
        );
      }
      this.options.threadDirectories.set(session.id, directory);
      return session;
    }
    const session = await this.options.client.createSession(directory);
    this.runtimeThreadId = session.id;
    this.options.threadDirectories.set(session.id, directory);
    await this.options.context.onRuntimeSessionId(session.id);
    return session;
  }

  private async handlePermission(
    permission: PermissionRequest,
    input: ConnectRuntimePrompt,
    pending: Map<string, "permission" | "question">,
  ): Promise<void> {
    const requestID = permission.id;
    pending.set(requestID, "permission");
    const directory = this.active?.directory ?? "";
    if (!input.interactionPort || !input.metadata?.sessionRef || !input.turnId || !input.turnOrigin) {
      pending.delete(requestID);
      await this.options.client.replyPermission(requestID, directory, "reject");
      return;
    }
    const action = permissionAction(permission.permission);
    if (
      action === "file-change" &&
      permission.patterns.some(
        (path) =>
          !isWithinTrustedRoots(isAbsolute(path) ? path : resolve(directory, path), this.active?.trustedRoots ?? []),
      )
    ) {
      pending.delete(requestID);
      await this.options.client.replyPermission(requestID, directory, "reject");
      return;
    }
    const response = await input.interactionPort.request(
      {
        kind: "approval",
        action,
        title: `允许 OpenCode 使用 ${permission.permission}？`,
        description: permission.patterns.join("\n") || "OpenCode 请求执行受权限控制的操作。",
        ...(action === "command"
          ? { command: stringValue(permission.metadata.command) || permission.patterns.join(" ") }
          : { files: permission.patterns.map((path) => ({ path })) }),
        options: approvalOptions(),
      },
      interactionContext(input),
    );
    if (!pending.delete(requestID)) return;
    const reply =
      response.kind !== "approval" || response.optionId === "deny" || response.optionId === "cancel"
        ? "reject"
        : response.optionId === "approve-session"
          ? "always"
          : "once";
    await this.options.client.replyPermission(requestID, directory, reply);
  }

  private async handleQuestion(
    question: QuestionRequest,
    input: ConnectRuntimePrompt,
    pending: Map<string, "permission" | "question">,
  ): Promise<void> {
    const requestID = question.id;
    pending.set(requestID, "question");
    const directory = this.active?.directory ?? "";
    if (!input.interactionPort || !input.metadata?.sessionRef || !input.turnId || !input.turnOrigin) {
      pending.delete(requestID);
      await this.options.client.rejectQuestion(requestID, directory);
      return;
    }
    const questions = question.questions.map(runtimeQuestion);
    const response = await input.interactionPort.request(
      {
        kind: "user-input",
        title: "OpenCode 需要你的回答",
        description: questions.length === 1 ? (questions[0]?.prompt ?? "") : `请回答 ${questions.length} 个问题。`,
        questions,
        autoResolutionMs: null,
      },
      interactionContext(input),
    );
    if (!pending.delete(requestID)) return;
    if (response.kind !== "user-input") {
      await this.options.client.rejectQuestion(requestID, directory);
      return;
    }
    await this.options.client.replyQuestion(
      requestID,
      directory,
      questions.map((item) => response.answers[item.id] ?? []),
    );
  }
}

async function pumpEvents(
  client: OpenCodeServerClient,
  signal: AbortSignal,
  listeners: Set<EventListener>,
  onConnected: () => void,
  onFailure: (failure: Error) => Promise<void>,
): Promise<void> {
  try {
    for await (const event of client.events(signal, onConnected)) {
      await Promise.all([...listeners].map(async (listener) => await listener(event)));
    }
    if (!signal.aborted) throw new Error("OpenCode global event stream ended");
  } catch (error) {
    if (signal.aborted) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    await Promise.all([...listeners].map(async (listener) => await listener(failure)));
    await onFailure(failure);
  }
}

function summarizeSessions(sessions: Session[], directories: Map<string, string>) {
  return sessions
    .filter((session) => !session.parentID)
    .map((session) => {
      const directory = canonical(session.directory);
      directories.set(session.id, directory);
      return {
        runtimeThreadId: session.id,
        parentRuntimeThreadId: null,
        name: session.title || null,
        updatedAt: session.time.updated,
        workingDirectory: directory,
        workspaceKind: "persistent" as const,
        workspaceIdentity: {
          key: `opencode:${directory}`,
          kind: "persistent" as const,
          localRoot: directory,
        },
      };
    });
}

function sessionOptions(
  agents: Agent[],
  providers: { all: Provider[]; connected: string[]; default: Record<string, string> },
): RuntimeSessionOption[] {
  const models = connectedModels(providers);
  const variants = [...new Set(models.flatMap(({ model }) => Object.keys(model.variants ?? {})))].sort();
  return [
    {
      id: "agent",
      displayName: "Agent",
      description: "OpenCode primary agent",
      category: "agent",
      changePolicy: "in-place",
      values: agents
        .filter((agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"))
        .map((agent) => ({ id: agent.name, displayName: agent.name, description: agent.description })),
    },
    {
      id: "model",
      displayName: "Model",
      description: "OpenCode provider-qualified model",
      category: "model",
      changePolicy: "in-place",
      values: models.map(({ provider, model }) => ({
        id: `${provider.id}/${model.id}`,
        displayName: `${provider.name} · ${model.name}`,
      })),
    },
    {
      id: "variant",
      displayName: "Variant",
      description: "OpenCode model variant",
      category: "variant",
      changePolicy: "in-place",
      values: variants.map((id) => ({ id, displayName: id })),
    },
  ];
}

function modelOptions(providers: {
  all: Provider[];
  connected: string[];
  default: Record<string, string>;
}): RuntimeModelOption[] {
  return connectedModels(providers).map(({ provider, model }) => {
    const variants = Object.keys(model.variants ?? {});
    const defaultModel = providers.default[provider.id];
    return {
      id: `${provider.id}/${model.id}`,
      displayName: model.name,
      description: `${provider.name} · ${model.status}`,
      isDefault: defaultModel === model.id || defaultModel === `${provider.id}/${model.id}`,
      defaultReasoningEffort: variants[0] ?? "default",
      supportedReasoningEfforts: variants.length > 0 ? variants : ["default"],
      inputModalities: [
        "text" as const,
        ...(model.capabilities.input.image ? (["image"] as const) : []),
        ...(model.capabilities.input.audio ? (["audio"] as const) : []),
      ],
      turnSubmissionCapability: {
        prompt: { allowed: true, required: false },
        attachments: {
          allowedKinds: ["image" as const, "file" as const, "audio" as const, "video" as const],
          allowedMediaTypes: ["*/*"],
        },
      },
    };
  });
}

function connectedModels(providers: { all: Provider[]; connected: string[]; default: Record<string, string> }) {
  const connected = new Set(providers.connected);
  return providers.all.flatMap((provider) =>
    connected.has(provider.id) ? Object.values(provider.models).map((model) => ({ provider, model })) : [],
  );
}

function activitySnapshot(messages: OpenCodeMessage[]): RuntimeActivitySnapshot {
  return {
    completeness: "complete",
    limitations: [],
    activities: messages.flatMap((message, turn) =>
      message.parts.map((part, index) => activityForPart(message.info, part, `${turn}.${index + 1}`)),
    ),
  };
}

function activityForPart(message: Message, part: Part, position: string): RuntimeActivity {
  const base = {
    id: part.id,
    position,
    parentId: null,
    state: partState(part),
    source: "history" as const,
  };
  if (part.type === "text") {
    return { ...base, kind: message.role === "user" ? ("user" as const) : ("assistant" as const), text: part.text };
  }
  if (part.type === "reasoning") return { ...base, kind: "reasoning", text: part.text };
  if (part.type === "tool") return { ...base, ...toolActivity(part) };
  if (part.type === "patch") {
    return {
      ...base,
      kind: "file-change",
      text: part.files.join("\n"),
      data: {
        status: "complete",
        changes: part.files.map((path) => ({ path, kind: "modified", diff: "" })),
      },
    };
  }
  if (part.type === "subtask") {
    return {
      ...base,
      kind: "subagent",
      text: part.description,
      data: { title: part.description, role: part.agent, activityKind: "started" },
    };
  }
  if (part.type === "file") {
    return {
      ...base,
      kind: message.role === "user" ? ("user" as const) : ("assistant" as const),
      text: part.filename ? `${part.filename} (${part.mime})` : part.url,
    };
  }
  if (["step-start", "step-finish", "retry", "compaction"].includes(part.type)) {
    return { ...base, kind: "progress", text: progressText(part) };
  }
  return { ...base, kind: "unknown", text: `OpenCode ${part.type} activity` };
}

function toolActivity(part: ToolPart): Pick<RuntimeActivity, "kind" | "text" | "data"> {
  const status = part.state.status;
  const output =
    status === "completed"
      ? part.state.output
      : status === "error"
        ? part.state.error
        : status === "pending"
          ? part.state.raw
          : "";
  const title = "title" in part.state ? part.state.title || part.tool : part.tool;
  const command = stringValue(part.state.input.command);
  if (["bash", "shell"].includes(part.tool)) {
    return { kind: "command", text: [title, output].filter(Boolean).join("\n\n"), data: { command, status } };
  }
  if (["edit", "write", "patch", "apply_patch"].includes(part.tool)) {
    const path = stringValue(part.state.input.filePath) || stringValue(part.state.input.path);
    return {
      kind: "file-change",
      text: [title, output].filter(Boolean).join("\n\n"),
      data: { status, changes: path ? [{ path, kind: "modified", diff: output }] : [] },
    };
  }
  return { kind: "tool", text: [title, output].filter(Boolean).join("\n\n"), data: { title, status } };
}

function partState(part: Part): RuntimeActivity["state"] {
  if (part.type === "tool") {
    if (part.state.status === "pending" || part.state.status === "running") return "streaming";
    if (part.state.status === "error") return "error";
  }
  if ((part.type === "text" || part.type === "reasoning") && part.time && !part.time.end) return "streaming";
  return "complete";
}

function progressText(part: Part): string {
  if (part.type === "step-start") return "OpenCode step started.";
  if (part.type === "step-finish") return `OpenCode step finished: ${part.reason}`;
  if (part.type === "retry") return `OpenCode retry ${part.attempt}.`;
  if (part.type === "compaction") return "OpenCode compacted the Session context.";
  return `OpenCode ${part.type} activity`;
}

function promptParts(input: ConnectRuntimePrompt) {
  return [
    ...(input.prompt.trim() ? [{ type: "text" as const, text: input.prompt }] : []),
    ...(input.media ?? []).map((media) => ({
      type: "file" as const,
      mime: media.mime || "application/octet-stream",
      ...(media.name ? { filename: media.name } : {}),
      url: media.stagedPath ? pathToFileURL(media.stagedPath).href : media.url,
    })),
  ];
}

function promptSelection(input: ConnectRuntimePrompt) {
  const agent = input.sessionOptions?.agent ?? input.mode;
  const model = input.sessionOptions?.model ?? input.model;
  const variant = input.sessionOptions?.variant ?? input.reasoningEffort;
  const parsedModel = model ? parseModel(model) : null;
  return {
    ...(agent ? { agent } : {}),
    ...(parsedModel ? { model: parsedModel } : {}),
    ...(variant && variant !== "default" ? { variant } : {}),
  };
}

function parseModel(value: string): { providerID: string; modelID: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`OpenCode model must be provider-qualified: ${value}`);
  }
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

async function validatePromptSelection(
  client: OpenCodeServerClient,
  input: ConnectRuntimePrompt,
  directory: string,
): Promise<void> {
  const selected = promptSelection(input);
  if (selected.agent) {
    const agent = (await client.listAgents(directory)).find((candidate) => candidate.name === selected.agent);
    if (!agent || agent.hidden || (agent.mode !== "primary" && agent.mode !== "all"))
      throw new Error(`Saved OpenCode agent is unavailable: ${selected.agent}`);
  }
  if (selected.model) {
    const providers = await client.listProviders(directory);
    const provider = providers.all.find(
      (candidate) => candidate.id === selected.model?.providerID && providers.connected.includes(candidate.id),
    );
    const model = provider?.models[selected.model.modelID];
    if (!model)
      throw new Error(`Saved OpenCode model is unavailable: ${selected.model.providerID}/${selected.model.modelID}`);
    if (selected.variant && !Object.hasOwn(model.variants ?? {}, selected.variant))
      throw new Error(`Saved OpenCode variant is unavailable for the selected model: ${selected.variant}`);
  } else if (selected.variant) {
    throw new Error("An OpenCode variant requires a provider-qualified model selection");
  }
}

function isWithinTrustedRoots(path: string, trustedRoots: string[]): boolean {
  const candidate = canonical(path);
  return trustedRoots.some((root) => {
    const nested = relative(canonical(root), candidate);
    return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
  });
}

function runtimeQuestion(question: QuestionInfo, index: number) {
  return {
    id: `question-${index + 1}`,
    header: question.header || `问题 ${index + 1}`,
    prompt: question.question,
    secret: false,
    allowOther: question.custom !== false,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            id: option.label,
            label: option.label,
            description: option.description || undefined,
          }))
        : null,
  };
}

function interactionContext(input: ConnectRuntimePrompt) {
  return {
    sessionRef: input.metadata?.sessionRef ?? "",
    turnId: input.turnId ?? "",
    origin: input.turnOrigin ?? "client",
    deliveryConfirmation: Promise.resolve(),
  } as const;
}

function approvalOptions() {
  return [
    { id: "approve-once" as const, label: "允许一次" },
    { id: "approve-session" as const, label: "本 Session 始终允许" },
    { id: "deny" as const, label: "拒绝" },
  ];
}

function permissionAction(permission: string): "command" | "file-change" {
  return ["edit", "write", "patch"].includes(permission) ? "file-change" : "command";
}

function errorActivity(turnId: string | undefined, error: Error): RuntimeActivity {
  return {
    id: `turn:${turnId || "unknown"}:error`,
    position: "0.0",
    parentId: null,
    kind: "error",
    text: `OpenCode execution failed: ${error.message}`,
    state: "error",
    source: "live",
    data: { code: "opencode-execution-failed" },
  };
}

function nativeErrorText(properties: Record<string, unknown> | undefined): string {
  const error = properties?.error;
  if (error && typeof error === "object") {
    const data = (error as Record<string, unknown>).data;
    if (data && typeof data === "object") {
      const message = stringValue((data as Record<string, unknown>).message);
      if (message) return message;
    }
  }
  return stringValue(properties?.message) || "OpenCode Session failed";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function canonical(directory: string): string {
  const absolute = resolve(directory);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function requireOpenCodeBinding(binding: AgentBindingConfig): OpenCodeAgentBindingConfig {
  if (binding.kind !== "opencode") throw new Error("OpenCode Runtime Adapter requires an OpenCode Agent Binding");
  return binding;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class ActivityQueue implements AsyncIterable<RuntimeActivity> {
  private readonly values: RuntimeActivity[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<RuntimeActivity>): void;
    reject(error: unknown): void;
  }> = [];
  isClosed = false;
  private failure: unknown = null;

  push(value: RuntimeActivity): void {
    if (this.isClosed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.isClosed) return;
    this.failure = error;
    this.isClosed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeActivity> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.failure) throw this.failure;
        if (this.isClosed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<RuntimeActivity>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
