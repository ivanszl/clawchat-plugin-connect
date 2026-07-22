import { describe, expect, it, mock } from "bun:test";
import type { RuntimeOutputEvent } from "../src/output-visibility";
import { createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
import type {
  CodexAppServerClient,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerRequestHandler,
  CodexAppServerThread,
  CodexAppServerTurn,
  CodexThreadResumeParams,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from "../src/runtime/codex-app-server";
import type { ConnectRuntimeSession, ConnectRuntimeStartContext } from "../src/runtime/types";
import type { CodexAgentBindingConfig, RuntimeWorkspace } from "../src/types";

const workspace: RuntimeWorkspace = {
  projectId: "project-1",
  workingDirectory: "/repo",
  additionalDirectories: ["/project-shared"],
  skipGitRepoCheck: false,
};

const agent: CodexAgentBindingConfig = {
  kind: "codex",
  model: "gpt-5-codex",
  sandboxMode: "workspace-write",
  modelReasoningEffort: "high",
  approvalPolicy: "never",
  webSearchMode: "live",
  networkAccessEnabled: true,
  additionalDirectories: ["/shared"],
};

function context(overrides: Partial<ConnectRuntimeStartContext> = {}): ConnectRuntimeStartContext {
  return {
    agentId: "codex",
    chatId: "chat-1",
    sessionId: "session-1",
    runtimeSessionId: null,
    configPath: "/tmp/connect config.json",
    stateDbPath: "/tmp/connect state.sqlite",
    onRuntimeSessionId: mock(async () => undefined),
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<CodexAppServerThread> = {}): CodexAppServerThread {
  return {
    id,
    preview: "Fix the runtime",
    name: null,
    createdAt: 10,
    updatedAt: 20,
    recencyAt: 20,
    cwd: "/repo",
    ...overrides,
  };
}

function turn(id = "turn-1", overrides: Partial<CodexAppServerTurn> = {}): CodexAppServerTurn {
  return { id, status: "inProgress", error: null, ...overrides };
}

class FakeAppServer implements CodexAppServerClient {
  readonly listThreads = mock(async () => ({ data: [] as CodexAppServerThread[], nextCursor: null as string | null }));
  readonly startThread = mock(async (_params: CodexThreadStartParams) => ({ thread: thread("thread-new") }));
  readonly resumeThread = mock(async (params: CodexThreadResumeParams) => ({ thread: thread(params.threadId) }));
  readonly readThread = mock(async (params: { threadId: string; includeTurns: true }) => ({
    thread: thread(params.threadId, { turns: [] }),
  }));
  readonly archiveThread = mock(async (_params: { threadId: string }) => undefined);
  readonly unarchiveThread = mock(async (params: { threadId: string }) => ({ thread: thread(params.threadId) }));
  readonly deleteThread = mock(async (_params: { threadId: string }) => undefined);
  readonly startTurn = mock(async (_params: CodexTurnStartParams) => ({ turn: turn() }));
  readonly interruptTurn = mock(async (_params: { threadId: string; turnId: string }) => undefined);
  readonly close = mock(async () => undefined);
  private readonly notifications = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly requests = new Set<CodexAppServerRequestHandler>();

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onRequest(handler: CodexAppServerRequestHandler): () => void {
    this.requests.add(handler);
    return () => this.requests.delete(handler);
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.notifications) listener({ method, params });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const request: CodexAppServerRequest = { id: 99, method, params };
    for (const handler of this.requests) {
      const result = await handler(request);
      if (result.handled) return result.result;
    }
    throw new Error(`unhandled request: ${method}`);
  }
}

async function collect(session: ConnectRuntimeSession): Promise<RuntimeOutputEvent[]> {
  const output: RuntimeOutputEvent[] = [];
  for await (const event of session.prompt({ prompt: "hello", workspace })) output.push(event);
  return output;
}

function emitCompletedTurn(client: FakeAppServer, threadId: string, items: Array<Record<string, unknown>>): void {
  client.emit("turn/started", { threadId, turn: turn() });
  for (const item of items) {
    client.emit("item/started", { threadId, turnId: "turn-1", item });
    client.emit("item/completed", { threadId, turnId: "turn-1", item });
  }
  client.emit("turn/completed", {
    threadId,
    turn: turn("turn-1", { status: "completed" }),
  });
}

describe("Codex app-server runtime adapter", () => {
  it("shares one app-server across discovery and runtime sessions", async () => {
    const client = new FakeAppServer();
    const createAppServer = mock(async () => client);
    const adapter = createCodexRuntimeAdapter({ createAppServer });

    await adapter.discoverThreads?.(agent, workspace);
    const first = await adapter.start(agent, context({ chatId: "chat-1" }));
    const second = await adapter.start(agent, context({ chatId: "chat-2", sessionId: "session-2" }));

    expect(createAppServer).toHaveBeenCalledTimes(1);
    await first.close();
    await second.close();
    expect(client.close).not.toHaveBeenCalled();
    await adapter.close?.();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("discovers persisted threads through paginated thread/list", async () => {
    const client = new FakeAppServer();
    client.listThreads
      .mockResolvedValueOnce({
        data: [thread("thread-newest", { name: "Named thread", updatedAt: 30 })],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [thread("thread-old", { preview: "ClawChat direct message from Colin: Older task", updatedAt: 20 })],
        nextCursor: null,
      });
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });

    await expect(adapter.discoverThreads?.(agent, workspace)).resolves.toEqual([
      { runtimeThreadId: "thread-newest", name: "Named thread", updatedAt: 30_000, workingDirectory: "/repo" },
      { runtimeThreadId: "thread-old", name: "Older task", updatedAt: 20_000, workingDirectory: "/repo" },
    ]);
    expect(client.listThreads).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cursor: null,
        cwd: "/repo",
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: expect.arrayContaining(["cli", "vscode", "exec", "appServer", "subAgent", "unknown"]),
      }),
    );
    expect(client.listThreads).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "page-2" }));
  });

  it("keeps child threads out of discovery and nests their transcript under the parent activity", async () => {
    const client = new FakeAppServer();
    const parent = thread("thread-parent", {
      turns: [
        {
          id: "turn-parent",
          status: "completed",
          items: [
            {
              type: "subAgentActivity",
              id: "activity-1",
              kind: "started",
              agentThreadId: "thread-child",
              agentPath: "researcher",
            },
          ],
        },
      ],
    });
    const child = thread("thread-child", {
      parentThreadId: "thread-parent",
      agentNickname: "Scout",
      agentRole: "researcher",
      turns: [
        {
          id: "turn-child",
          status: "completed",
          items: [
            { type: "userMessage", id: "child-user", content: [{ type: "text", text: "Investigate it" }] },
            { type: "agentMessage", id: "child-agent", text: "Found the cause" },
          ],
        },
      ],
    } as Partial<CodexAppServerThread>);
    client.listThreads.mockResolvedValueOnce({ data: [parent, child], nextCursor: null });
    client.readThread.mockImplementation(async ({ threadId }) => ({
      thread: threadId === "thread-child" ? child : parent,
    }));
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });

    await expect(adapter.discoverAllThreads?.(agent)).resolves.toEqual([
      { runtimeThreadId: "thread-parent", name: "Fix the runtime", updatedAt: 20_000, workingDirectory: "/repo" },
    ]);
    await expect(adapter.readTranscript?.(agent, "thread-parent")).resolves.toEqual([
      {
        id: "activity-1",
        kind: "subagent",
        text: "Scout · researcher",
        state: "complete",
        data: { title: "Scout", role: "researcher", activityKind: "started" },
        children: [
          { id: "child-user", kind: "user", text: "Investigate it", state: "complete" },
          { id: "child-agent", kind: "assistant", text: "Found the cause", state: "complete" },
        ],
      },
    ]);
    expect(client.readThread).toHaveBeenCalledWith({ threadId: "thread-child", includeTurns: true });
  });

  it("discovers archived threads separately and delegates lifecycle mutations", async () => {
    const client = new FakeAppServer();
    client.listThreads.mockResolvedValueOnce({
      data: [thread("thread-archived", { name: "Archived task" })],
      nextCursor: null,
    });
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });

    await expect(adapter.discoverArchivedThreads?.(agent)).resolves.toEqual([
      {
        runtimeThreadId: "thread-archived",
        name: "Archived task",
        updatedAt: 20_000,
        workingDirectory: "/repo",
        isArchived: true,
      },
    ]);
    expect(client.listThreads).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
    await adapter.archiveThread?.(agent, "thread-1");
    await adapter.unarchiveThread?.(agent, "thread-1");
    await adapter.deleteThread?.(agent, "thread-1");
    expect(client.archiveThread).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(client.unarchiveThread).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(client.deleteThread).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  it("starts a thread and maps binding settings to stable app-server params", async () => {
    const client = new FakeAppServer();
    client.startTurn.mockImplementationOnce(async () => {
      queueMicrotask(() => emitCompletedTurn(client, "thread-new", [{ type: "agentMessage", id: "a1", text: "done" }]));
      return { turn: turn() };
    });
    const started = context();
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });
    const session = await adapter.start(agent, started);

    await expect(collect(session)).resolves.toContainEqual(
      expect.objectContaining({ kind: "final", text: "done", itemId: "a1", state: "complete" }),
    );
    expect(client.startThread).toHaveBeenCalledWith({
      model: "gpt-5-codex",
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: {
        model_reasoning_effort: "high",
        web_search: "live",
        sandbox_workspace_write: {
          network_access: true,
          writable_roots: ["/shared", "/project-shared"],
        },
      },
    });
    expect(client.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-new",
        input: [{ type: "text", text: "hello", text_elements: [] }],
        cwd: "/repo",
        effort: "high",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo", "/shared", "/project-shared"],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }),
    );
    expect(started.onRuntimeSessionId).toHaveBeenCalledWith("thread-new");
  });

  it("resumes a persisted Codex thread", async () => {
    const client = new FakeAppServer();
    client.startTurn.mockImplementationOnce(async () => {
      queueMicrotask(() => emitCompletedTurn(client, "thread-old", []));
      return { turn: turn() };
    });
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });
    const session = await adapter.start(agent, context({ runtimeSessionId: "thread-old" }));

    await collect(session);
    expect(client.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-old", cwd: "/repo", sandbox: "workspace-write" }),
    );
    expect(client.startThread).not.toHaveBeenCalled();
  });

  it("maps completed app-server items and emits the latest agent message once as final", async () => {
    const client = new FakeAppServer();
    client.startTurn.mockImplementationOnce(async () => {
      queueMicrotask(() =>
        emitCompletedTurn(client, "thread-new", [
          { type: "reasoning", id: "r1", summary: ["thinking"], content: [] },
          {
            type: "commandExecution",
            id: "c1",
            command: "bun test",
            aggregatedOutput: "ok",
            exitCode: 0,
            status: "completed",
          },
          { type: "agentMessage", id: "a1", text: "intermediate" },
          {
            type: "fileChange",
            id: "f1",
            changes: [{ path: "src/a.ts", kind: "update", diff: "" }],
            status: "completed",
          },
          { type: "agentMessage", id: "a2", text: "final answer" },
        ]),
      );
      return { turn: turn() };
    });
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });
    const session = await adapter.start(agent, context());
    const output = await collect(session);

    expect(output).toContainEqual(expect.objectContaining({ kind: "reasoning", text: "thinking", itemId: "r1" }));
    expect(output).toContainEqual(expect.objectContaining({ kind: "tool", text: expect.stringContaining("bun test") }));
    expect(output).toContainEqual(expect.objectContaining({ kind: "tool", text: expect.stringContaining("src/a.ts") }));
    expect(output).toContainEqual(expect.objectContaining({ kind: "assistant", text: "intermediate", itemId: "a1" }));
    expect(output.filter((event) => event.kind === "final")).toEqual([
      expect.objectContaining({ kind: "final", text: "final answer", itemId: "a2", state: "complete" }),
    ]);
  });

  it("validates Codex sandbox modes supplied by the chat session", async () => {
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => new FakeAppServer() });
    const session = await adapter.start(agent, context());

    await expect(
      (async () => {
        for await (const _event of session.prompt({ prompt: "hello", workspace, mode: "plan" })) {
          // Consume the generator.
        }
      })(),
    ).rejects.toThrow(/read-only.*workspace-write.*danger-full-access/u);
  });

  it("routes approval requests to the active session and cancels them safely", async () => {
    const client = new FakeAppServer();
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });
    const session = await adapter.start({ ...agent, approvalPolicy: "on-request" }, context());
    const iterator = session.prompt({ prompt: "hello", workspace })[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    while (client.startTurn.mock.calls.length === 0) await Bun.sleep(0);

    await expect(
      client.request("item/commandExecution/requestApproval", {
        threadId: "thread-new",
        turnId: "turn-1",
        command: "git push",
      }),
    ).resolves.toEqual({ decision: "cancel" });
    await expect(firstEvent).resolves.toMatchObject({
      done: false,
      value: { kind: "control", requiredControl: true, text: expect.stringContaining("git push") },
    });
    client.emit("turn/completed", {
      threadId: "thread-new",
      turn: turn("turn-1", { status: "interrupted" }),
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "progress", state: "cancelled", itemId: "turn:turn-1" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("interrupts active turns with turn/interrupt", async () => {
    const client = new FakeAppServer();
    client.startTurn.mockImplementationOnce(async () => {
      queueMicrotask(() => client.emit("turn/started", { threadId: "thread-new", turn: turn() }));
      return { turn: turn() };
    });
    client.interruptTurn.mockImplementationOnce(async () => {
      queueMicrotask(() =>
        client.emit("turn/completed", {
          threadId: "thread-new",
          turn: turn("turn-1", { status: "interrupted" }),
        }),
      );
    });
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });
    const session = await adapter.start(agent, context());
    const iterator = session.prompt({ prompt: "wait", workspace })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "progress" }, done: false });
    await expect(session.cancel?.()).resolves.toBe(true);
    expect(client.interruptTurn).toHaveBeenCalledWith({ threadId: "thread-new", turnId: "turn-1" });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "progress", state: "cancelled", itemId: "turn:turn-1" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(session.cancel?.()).resolves.toBe(false);
  });

  it("ends an active turn visibly when the shared app-server exits", async () => {
    const client = new FakeAppServer();
    client.startTurn.mockImplementationOnce(async () => {
      queueMicrotask(() => client.emit("turn/started", { threadId: "thread-new", turn: turn() }));
      return { turn: turn() };
    });
    const adapter = createCodexRuntimeAdapter({ createAppServer: async () => client });
    const session = await adapter.start(agent, context());
    const iterator = session.prompt({ prompt: "wait", workspace })[Symbol.asyncIterator]();

    await iterator.next();
    client.emit("$transport/exited", { message: "Codex app-server exited (code 1): boom" });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: "final", text: "Codex app-server exited (code 1): boom" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});
