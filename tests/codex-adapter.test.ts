import type { ThreadEvent } from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import { type CodexClientLike, type CodexThreadLike, createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
import type { ConnectRuntimeSession, ConnectRuntimeStartContext } from "../src/runtime/types";
import type { CodexAgentConfig } from "../src/types";

const agent: CodexAgentConfig = {
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
    onRuntimeSessionId: vi.fn(async () => undefined),
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
    runStreamed: vi.fn(async () => ({ events: events(threadEvents) })),
  };
  const client: CodexClientLike = {
    startThread: vi.fn(() => thread),
    resumeThread: vi.fn(() => thread),
  };
  return { client, thread };
}

async function collect(session: ConnectRuntimeSession) {
  const output = [];
  for await (const event of session.prompt({ prompt: "hello", cwd: "/repo" })) output.push(event);
  return output;
}

describe("Codex SDK runtime adapter", () => {
  it("starts a fresh thread with Codex options and automatic MCP exposure", async () => {
    const { client } = fakeClient([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { id: "a1", type: "agent_message", text: "done" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
      },
    ]);
    const createCodex = vi.fn(async () => client);
    const started = context();
    const adapter = createCodexRuntimeAdapter({ createCodex, binPath: "/package/dist/src/bin.js" });
    const session = await adapter.start(agent, started);

    expect(session.toolsAlreadyExposed).toBe(true);
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
        additionalDirectories: ["/shared"],
      }),
    );
    expect(started.onRuntimeSessionId).toHaveBeenCalledWith("thread-1");
    expect(createCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          mcp_servers: {
            clawchat_connect: {
              command: process.execPath,
              args: [
                "/package/dist/src/bin.js",
                "mcp-server",
                "--agent",
                "codex",
                "--config",
                "/tmp/connect config.json",
              ],
              env: {
                CLAWCHAT_CONNECT_CHAT_ID: "chat-1",
                CLAWCHAT_CONNECT_STATE_DB: "/tmp/connect state.sqlite",
              },
            },
          },
        },
      }),
    );
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
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client, binPath: "/bin.js" });
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
          command: "npm test",
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
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client, binPath: "/bin.js" });
    const session = await adapter.start(agent, context());
    const output = await collect(session);

    expect(output).toContainEqual({ kind: "reasoning", text: "thinking" });
    expect(output).toContainEqual(expect.objectContaining({ kind: "tool", text: expect.stringContaining("npm test") }));
    expect(output).toContainEqual(expect.objectContaining({ kind: "tool", text: expect.stringContaining("src/a.ts") }));
    expect(output).toContainEqual({ kind: "assistant", text: "intermediate" });
    expect(output.filter((event) => event.kind === "final")).toEqual([{ kind: "final", text: "final answer" }]);
  });

  it("validates Codex sandbox modes supplied by the chat session", async () => {
    const { client } = fakeClient([]);
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client, binPath: "/bin.js" });
    const session = await adapter.start(agent, context());

    await expect(
      (async () => {
        for await (const _event of session.prompt({ prompt: "hello", cwd: "/repo", mode: "plan" })) {
          // Consume the generator.
        }
      })(),
    ).rejects.toThrow(/read-only.*workspace-write.*danger-full-access/u);
  });

  it("cancels an active Codex turn through AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    const thread: CodexThreadLike = {
      id: null,
      runStreamed: vi.fn(async (_input, options) => {
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
    const adapter = createCodexRuntimeAdapter({ createCodex: async () => client, binPath: "/bin.js" });
    const session = await adapter.start(agent, context());
    const iterator = session.prompt({ prompt: "wait", cwd: "/repo" })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "progress" }, done: false });
    await expect(session.cancel?.()).resolves.toBe(true);
    expect(signal?.aborted).toBe(true);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(session.cancel?.()).resolves.toBe(false);
  });
});
