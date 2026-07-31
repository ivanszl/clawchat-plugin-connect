import { describe, expect, it } from "bun:test";
import type { Agent, GlobalEvent, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { createOpenCodeRuntimeAdapter } from "../src/runtime/opencode-adapter";
import type { OpenCodeMessage, OpenCodePromptInput, OpenCodeServerClient } from "../src/runtime/opencode-server";
import type { RuntimeInteractionRequest } from "../src/runtime/types";

const directory = "/repo";

function nativeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    slug: "calm-forest",
    projectID: "project-1",
    directory,
    title: "Existing work",
    version: "1.18.10",
    time: { created: 10, updated: 20 },
    ...overrides,
  };
}

function provider(): Provider {
  return {
    id: "anthropic",
    name: "Anthropic",
    source: "config",
    env: [],
    options: {},
    models: {
      "claude-sonnet": {
        id: "claude-sonnet",
        providerID: "anthropic",
        api: { id: "claude-sonnet", url: "https://example.invalid", npm: "@ai-sdk/anthropic" },
        name: "Claude Sonnet",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: true, image: true, video: true, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200_000, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-01-01",
        variants: { low: {}, high: {} },
      },
    },
  };
}

function history(): OpenCodeMessage[] {
  return [
    {
      info: {
        id: "message-user",
        sessionID: "session-1",
        role: "user",
        time: { created: 11 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
      },
      parts: [
        {
          id: "part-user",
          sessionID: "session-1",
          messageID: "message-user",
          type: "text",
          text: "inspect",
        },
      ],
    },
    {
      info: {
        id: "message-assistant",
        sessionID: "session-1",
        role: "assistant",
        parentID: "message-user",
        time: { created: 12, completed: 14 },
        agent: "build",
        mode: "build",
        modelID: "claude-sonnet",
        providerID: "anthropic",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "part-reasoning",
          sessionID: "session-1",
          messageID: "message-assistant",
          type: "reasoning",
          text: "checking",
          time: { start: 12, end: 13 },
        },
        {
          id: "part-tool",
          sessionID: "session-1",
          messageID: "message-assistant",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: directory,
            title: "Run pwd",
            metadata: {},
            time: { start: 12, end: 13 },
          },
        },
        {
          id: "part-answer",
          sessionID: "session-1",
          messageID: "message-assistant",
          type: "text",
          text: "done",
          time: { start: 13, end: 14 },
        },
      ],
    },
  ];
}

class EventQueue {
  private readonly values: GlobalEvent[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<GlobalEvent>): void;
    signal: AbortSignal;
    onAbort(): void;
  }> = [];

  push(value: GlobalEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({ done: false, value });
    } else this.values.push(value);
  }

  async *iterate(signal: AbortSignal): AsyncIterable<GlobalEvent> {
    while (!signal.aborted) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      const result = await new Promise<IteratorResult<GlobalEvent>>((resolve) => {
        const onAbort = () => {
          const index = this.waiters.findIndex((waiter) => waiter.onAbort === onAbort);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve({ done: true, value: undefined });
        };
        this.waiters.push({ resolve, signal, onAbort });
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (!result.done) yield result.value;
    }
  }
}

function fixture() {
  const events = new EventQueue();
  const sessions = [nativeSession(), nativeSession({ id: "child-1", parentID: "session-1", title: "Child" })];
  const prompts: OpenCodePromptInput[] = [];
  const permissionReplies: string[] = [];
  let deletes = 0;
  let aborts = 0;
  let settlePermission!: () => void;
  const permissionReplied = new Promise<void>((resolve) => {
    settlePermission = resolve;
  });
  const agents: Agent[] = [
    { name: "build", mode: "primary", permission: [], options: {} },
    { name: "explore", mode: "subagent", permission: [], options: {} },
  ];
  const client: OpenCodeServerClient = {
    version: "1.18.10",
    health: async () => ({ healthy: true, version: "1.18.10" }),
    listAgents: async () => agents,
    listProviders: async () => ({
      all: [provider()],
      connected: ["anthropic"],
      default: { anthropic: "claude-sonnet" },
    }),
    listSessions: async () => sessions,
    getSession: async (sessionID) => {
      const session = sessions.find((candidate) => candidate.id === sessionID);
      if (!session) throw new Error("not found");
      return session;
    },
    createSession: async () => {
      const created = nativeSession({ id: "created-1", title: "New session" });
      sessions.push(created);
      return created;
    },
    deleteSession: async (sessionID) => {
      const index = sessions.findIndex((session) => session.id === sessionID);
      if (index < 0) return false;
      sessions.splice(index, 1);
      deletes += 1;
      return true;
    },
    sessionStatus: async () => ({}),
    messages: async () => history(),
    promptAsync: async (input) => {
      prompts.push(input);
      events.push({
        directory,
        payload: {
          id: "event-part",
          type: "message.part.updated",
          properties: {
            sessionID: input.sessionID,
            part: history()[1]?.parts[2],
            time: 14,
          },
        },
      } as GlobalEvent);
      events.push({
        directory,
        payload: {
          id: "event-idle",
          type: "session.idle",
          properties: { sessionID: input.sessionID },
        },
      } as GlobalEvent);
    },
    abortSession: async () => {
      aborts += 1;
      return true;
    },
    events: (signal, onConnected) => {
      onConnected?.();
      return events.iterate(signal);
    },
    replyPermission: async (_requestID, _directory, reply) => {
      permissionReplies.push(reply);
      settlePermission();
      return true;
    },
    replyQuestion: async () => true,
    rejectQuestion: async () => true,
    close: async () => undefined,
  };
  return {
    client,
    events,
    prompts,
    permissionReplies,
    permissionReplied,
    deletes: () => deletes,
    aborts: () => aborts,
  };
}

describe("OpenCode Runtime Adapter", () => {
  it("discovers native capabilities and only top-level Runtime Threads", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const binding = { kind: "opencode" as const };

    const options = await adapter.listSessionOptions?.(binding, {
      projectId: "p",
      workingDirectory: directory,
      additionalDirectories: [],
      skipGitRepoCheck: true,
    });
    expect(options?.map((option) => option.id)).toEqual(["agent", "model", "variant"]);
    expect(options?.find((option) => option.id === "agent")?.values.map((value) => value.id)).toEqual(["build"]);
    expect(options?.find((option) => option.id === "model")?.values.map((value) => value.id)).toEqual([
      "anthropic/claude-sonnet",
    ]);
    expect(options?.find((option) => option.id === "variant")?.values.map((value) => value.id)).toEqual([
      "high",
      "low",
    ]);
    expect(await adapter.listModels?.(binding)).toEqual([
      expect.objectContaining({
        id: "anthropic/claude-sonnet",
        isDefault: true,
        supportedReasoningEfforts: ["low", "high"],
      }),
    ]);
    expect(await adapter.discoverAllThreads?.(binding)).toEqual([
      expect.objectContaining({
        runtimeThreadId: "session-1",
        name: "Existing work",
        workingDirectory: directory,
      }),
    ]);
    await adapter.close?.();
  });

  it("maps native history into stable runtime-neutral Activity and deletes natively", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const binding = { kind: "opencode" as const };

    const first = await adapter.readActivity?.(binding, "session-1");
    const second = await adapter.readActivity?.(binding, "session-1");
    expect(second).toEqual(first);
    expect(first?.activities.map(({ id, position, kind, text }) => ({ id, position, kind, text }))).toEqual([
      { id: "part-user", position: "0.1", kind: "user", text: "inspect" },
      { id: "part-reasoning", position: "1.1", kind: "reasoning", text: "checking" },
      { id: "part-tool", position: "1.2", kind: "command", text: "Run pwd\n\n/repo" },
      { id: "part-answer", position: "1.3", kind: "assistant", text: "done" },
    ]);

    await adapter.deleteThread?.(binding, "session-1");
    expect(test.deletes()).toBe(1);
    await adapter.close?.();
  });

  it("submits structured file parts and converges live output with authoritative history", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({
      createServer: async () => test.client,
      messageID: () => "connect-message",
    });
    let attached: string | null = null;
    const session = await adapter.start(
      { kind: "opencode" },
      {
        agentId: "open",
        chatId: "chat",
        sessionId: "connect-session",
        runtimeSessionId: null,
        configPath: "/tmp/config.json",
        stateDbPath: "/tmp/state.sqlite",
        onRuntimeSessionId: async (value) => {
          attached = value;
        },
      },
    );

    const activities = [];
    for await (const activity of session.prompt({
      prompt: "inspect",
      media: [
        {
          kind: "image",
          url: "https://media.example/image.png",
          stagedPath: "/tmp/staged image.png",
          name: "image.png",
          mime: "image/png",
        },
      ],
      workspace: { projectId: "p", workingDirectory: directory, additionalDirectories: [], skipGitRepoCheck: true },
      mode: "build",
      model: "anthropic/claude-sonnet",
      reasoningEffort: "high",
      metadata: { sessionRef: "ABCDEFGH" },
    })) {
      activities.push(activity);
    }

    expect(attached as string | null).toBe("created-1");
    expect(test.prompts).toEqual([
      {
        sessionID: "created-1",
        directory,
        messageID: "connect-message",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
        variant: "high",
        parts: [
          { type: "text", text: "inspect" },
          { type: "file", mime: "image/png", filename: "image.png", url: "file:///tmp/staged%20image.png" },
        ],
      },
    ]);
    expect(activities.some((activity) => activity.id === "part-answer" && activity.text === "done")).toBe(true);
    await session.close();
    await adapter.close?.();
  });

  it("routes owned permission requests through the originating Interaction and aborts natively", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const requests: RuntimeInteractionRequest[] = [];
    const session = await adapter.start(
      { kind: "opencode" },
      {
        agentId: "open",
        chatId: "chat",
        sessionId: "connect-session",
        runtimeSessionId: "session-1",
        configPath: "/tmp/config.json",
        stateDbPath: "/tmp/state.sqlite",
        onRuntimeSessionId: async () => undefined,
      },
    );

    const result = session.prompt({
      prompt: "run",
      workspace: { projectId: "p", workingDirectory: directory, additionalDirectories: [], skipGitRepoCheck: true },
      turnId: "turn-1",
      turnOrigin: "client",
      metadata: { sessionRef: "ABCDEFGH" },
      interactionPort: {
        request: async (request) => {
          requests.push(request);
          return { kind: "approval", optionId: "approve-session" };
        },
      },
    });
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-permission",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "session-1",
            permission: "bash",
            patterns: ["git status"],
            metadata: { command: "git status" },
            always: ["git status"],
          },
        },
      } as GlobalEvent);
    };
    const iterator = result[Symbol.asyncIterator]();
    const pendingActivity = iterator.next();
    await test.permissionReplied;
    await session.cancel?.();

    expect(test.aborts()).toBe(1);
    expect(requests).toEqual([
      expect.objectContaining({
        kind: "approval",
        action: "command",
        command: "git status",
      }),
    ]);
    expect(test.permissionReplies).toEqual(["always"]);
    await pendingActivity;
    await session.close();
    await adapter.close?.();
  });

  it("fails closed for unavailable saved selections and file permissions outside trusted roots", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start(
      { kind: "opencode" },
      {
        agentId: "open",
        chatId: "chat",
        sessionId: "connect-session",
        runtimeSessionId: "session-1",
        configPath: "/tmp/config.json",
        stateDbPath: "/tmp/state.sqlite",
        onRuntimeSessionId: async () => undefined,
      },
    );

    await expect(async () => {
      for await (const _activity of session.prompt({
        prompt: "run",
        workspace: { projectId: "p", workingDirectory: directory, additionalDirectories: [], skipGitRepoCheck: true },
        sessionOptions: { model: "missing/model" },
      })) {
        // No activity is expected.
      }
    }).toThrow("Saved OpenCode model is unavailable");

    const requests: RuntimeInteractionRequest[] = [];
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-permission-outside",
          type: "permission.asked",
          properties: {
            id: "permission-outside",
            sessionID: "session-1",
            permission: "edit",
            patterns: ["/outside/secrets.txt"],
            metadata: {},
            always: [],
          },
        },
      } as GlobalEvent);
    };
    const iterator = session
      .prompt({
        prompt: "edit",
        workspace: { projectId: "p", workingDirectory: directory, additionalDirectories: [], skipGitRepoCheck: true },
        turnId: "turn-boundary",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (request) => {
            requests.push(request);
            return { kind: "approval", optionId: "approve-once" };
          },
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await test.permissionReplied;
    await session.cancel?.();
    expect(requests).toEqual([]);
    expect(test.permissionReplies).toEqual(["reject"]);
    await pending;
    await adapter.close?.();
  });
});
