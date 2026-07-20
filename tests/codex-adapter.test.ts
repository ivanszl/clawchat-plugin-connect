import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { type CodexClientLike, type CodexThreadLike, createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
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
  skipGitRepoCheck: true,
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

function events(items: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function fakeClient(threadEvents: ThreadEvent[], threadId: string | null = null) {
  const thread: CodexThreadLike = {
    id: threadId,
    runStreamed: mock(async () => ({ events: events(threadEvents) })),
  };
  const client: CodexClientLike = {
    startThread: mock(() => thread),
    resumeThread: mock(() => thread),
  };
  return { client, thread };
}

async function collect(session: ConnectRuntimeSession) {
  const output = [];
  for await (const event of session.prompt({ prompt: "hello", workspace })) output.push(event);
  return output;
}

describe("Codex SDK runtime adapter", () => {
  it("discovers named persisted Codex threads for the selected workspace", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "clawchat-connect-codex-home-"));
    const sessions = join(codexHome, "sessions", "2026", "07", "20");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-current.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "thread-current", timestamp: "2026-07-20T05:21:56.682Z", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "Fix the session discovery flow" },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(sessions, "rollout-other.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "thread-other", timestamp: "2026-07-20T05:22:56.682Z", cwd: "/other" },
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Ignore me" } }),
      ].join("\n"),
    );
    const adapter = createCodexRuntimeAdapter();

    await expect(adapter.discoverThreads?.({ ...agent, env: { CODEX_HOME: codexHome } }, workspace)).resolves.toEqual([
      {
        runtimeThreadId: "thread-current",
        name: "Fix the session discovery flow",
        updatedAt: Date.parse("2026-07-20T05:21:56.682Z"),
      },
    ]);
  });

  it("starts a fresh thread without injecting Connect tools or MCP servers", async () => {
    const { client } = fakeClient([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { id: "a1", type: "agent_message", text: "done" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
      },
    ]);
    const createCodex = mock(async () => client);
    const started = context();
    const adapter = createCodexRuntimeAdapter({ createCodex });
    const session = await adapter.start(agent, started);

    await expect(collect(session)).resolves.toContainEqual({ kind: "final", text: "done" });
    expect(client.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
        model: "gpt-5-codex",
        sandboxMode: "workspace-write",
        modelReasoningEffort: "high",
        approvalPolicy: "never",
        webSearchMode: "live",
        networkAccessEnabled: true,
        skipGitRepoCheck: true,
        additionalDirectories: ["/shared", "/project-shared"],
      }),
    );
    expect(started.onRuntimeSessionId).toHaveBeenCalledWith("thread-1");
    expect(createCodex).toHaveBeenCalledWith({});
  });

  it("resumes a persisted Codex thread", async () => {
    const { client } = fakeClient(
      [
        { type: "item.completed", item: { id: "a1", type: "agent_message", text: "resumed" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        },
      ],
      "thread-old",
    );
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client });
    const session = await adapter.start(agent, context({ runtimeSessionId: "thread-old" }));

    await collect(session);
    expect(client.resumeThread).toHaveBeenCalledWith(
      "thread-old",
      expect.objectContaining({ workingDirectory: "/repo" }),
    );
    expect(client.startThread).not.toHaveBeenCalled();
  });

  it("maps structured events and emits the latest agent message exactly once as final", async () => {
    const { client } = fakeClient([
      { type: "turn.started" },
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "bun test",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "a1", type: "agent_message", text: "intermediate" } },
      {
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" },
      },
      { type: "item.completed", item: { id: "a2", type: "agent_message", text: "final answer" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 2 },
      },
    ]);
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client });
    const session = await adapter.start(agent, context());
    const output = await collect(session);

    expect(output).toContainEqual({ kind: "reasoning", text: "thinking" });
    expect(output).toContainEqual(expect.objectContaining({ kind: "tool", text: expect.stringContaining("bun test") }));
    expect(output).toContainEqual(expect.objectContaining({ kind: "tool", text: expect.stringContaining("src/a.ts") }));
    expect(output).toContainEqual({ kind: "assistant", text: "intermediate" });
    expect(output.filter((event) => event.kind === "final")).toEqual([{ kind: "final", text: "final answer" }]);
  });

  it("validates Codex sandbox modes supplied by the chat session", async () => {
    const { client } = fakeClient([]);
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client });
    const session = await adapter.start(agent, context());

    await expect(
      (async () => {
        for await (const _event of session.prompt({ prompt: "hello", workspace, mode: "plan" })) {
          // Consume the generator.
        }
      })(),
    ).rejects.toThrow(/read-only.*workspace-write.*danger-full-access/u);
  });

  it("cancels an active Codex turn through AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    const thread: CodexThreadLike = {
      id: null,
      runStreamed: mock(async (_input, options) => {
        signal = options?.signal;
        return {
          events: (async function* () {
            yield { type: "turn.started" } as const;
            if (!signal?.aborted) {
              await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
            }
          })(),
        };
      }),
    };
    const client: CodexClientLike = { startThread: () => thread, resumeThread: () => thread };
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client });
    const session = await adapter.start(agent, context());
    const iterator = session.prompt({ prompt: "wait", workspace })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "progress" }, done: false });
    await expect(session.cancel?.()).resolves.toBe(true);
    expect(signal?.aborted).toBe(true);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(session.cancel?.()).resolves.toBe(false);
  });
});
