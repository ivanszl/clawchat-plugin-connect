import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Command, GlobalEvent, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { TurnSubmission, type TurnSubmissionCapability } from "../src/client-interface/turn-submission";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import { ProjectCatalog } from "../src/projects";
import { ConnectRuntime } from "../src/runtime/connect-runtime";
import { createOpenCodeRuntimeAdapter } from "../src/runtime/opencode-adapter";
import type {
  OpenCodeCommandInput,
  OpenCodeMessage,
  OpenCodePromptInput,
  OpenCodeServerClient,
} from "../src/runtime/opencode-server";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimeStartContext, RuntimeActivity, RuntimeInteractionRequest } from "../src/runtime/types";
import { createStateStore } from "../src/state";
import type { RuntimeWorkspace } from "../src/types";
import type { ConnectWsClient } from "../src/ws-client";

const directory = "/repo";
const runtimeWorkspace = {
  projectId: "p",
  workingDirectory: directory,
  additionalDirectories: [],
  skipGitRepoCheck: true,
} satisfies RuntimeWorkspace;

function startContext(overrides: Partial<ConnectRuntimeStartContext> = {}): ConnectRuntimeStartContext {
  return {
    agentId: "open",
    chatId: "chat",
    sessionId: "connect-session",
    runtimeSessionId: "session-1",
    configPath: "/tmp/config.json",
    stateDbPath: "/tmp/state.sqlite",
    onRuntimeSessionId: async () => undefined,
    ...overrides,
  };
}

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

  disconnect(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve({ done: true, value: undefined });
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
      if (result.done) return;
      yield result.value;
    }
  }
}

function fixture() {
  const events = new EventQueue();
  const sessions = [nativeSession(), nativeSession({ id: "child-1", parentID: "session-1", title: "Child" })];
  const prompts: OpenCodePromptInput[] = [];
  const commands: OpenCodeCommandInput[] = [];
  const permissionReplies: string[] = [];
  const questionReplies: string[][][] = [];
  const nativeCalls: string[] = [];
  let questionRejects = 0;
  let deletes = 0;
  let aborts = 0;
  let closes = 0;
  let settlePermission!: () => void;
  const permissionReplied = new Promise<void>((resolve) => {
    settlePermission = resolve;
  });
  let settleQuestion!: () => void;
  const questionReplied = new Promise<void>((resolve) => {
    settleQuestion = resolve;
  });
  const agents: Agent[] = [
    { name: "build", mode: "primary", permission: [], options: {} },
    { name: "explore", mode: "subagent", permission: [], options: {} },
  ];
  const client: OpenCodeServerClient = {
    version: "1.18.10",
    health: async () => ({ healthy: true, version: "1.18.10" }),
    listAgents: async () => agents,
    listCommands: async () =>
      [
        {
          name: "grill-with-docs",
          description: "Challenge a proposal against primary documentation",
          source: "skill",
          template: "",
          hints: [],
        },
        { name: "compact", description: "Compact the Session", source: "command", template: "", hints: [] },
      ] satisfies Command[],
    listProviders: async () => ({
      all: [provider()],
      connected: ["anthropic"],
      default: { anthropic: "claude-sonnet" },
    }),
    listSessions: async (_directory, rootsOnly = true) =>
      rootsOnly ? sessions.filter((session) => !session.parentID) : sessions,
    getSession: async (sessionID) => {
      const session = sessions.find((candidate) => candidate.id === sessionID);
      if (!session) throw new Error("not found");
      return session;
    },
    createSession: async (sessionDirectory) => {
      const created = nativeSession({ id: "created-1", title: "New session", directory: sessionDirectory });
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
    runCommand: async (input) => {
      commands.push(input);
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
      nativeCalls.push("abort");
      aborts += 1;
      return true;
    },
    events: (signal, onConnected) => {
      onConnected?.();
      return events.iterate(signal);
    },
    replyPermission: async (_requestID, _directory, reply) => {
      nativeCalls.push(`permission:${reply}`);
      permissionReplies.push(reply);
      settlePermission();
      return true;
    },
    replyQuestion: async (_requestID, _directory, answers) => {
      questionReplies.push(answers);
      settleQuestion();
      return true;
    },
    rejectQuestion: async () => {
      nativeCalls.push("question:reject");
      questionRejects += 1;
      return true;
    },
    close: async () => {
      closes += 1;
    },
  };
  return {
    client,
    sessions,
    events,
    prompts,
    commands,
    permissionReplies,
    permissionReplied,
    questionReplies,
    questionReplied,
    questionRejects: () => questionRejects,
    nativeCalls,
    deletes: () => deletes,
    aborts: () => aborts,
    closes: () => closes,
  };
}

describe("OpenCode Runtime Adapter", () => {
  it("reconciles exact ClawChat input identities from authoritative native user messages", async () => {
    const batchIdentity = { messageId: "group-1", contentDigest: "sha256:group" };
    const contextIdentity = { messageId: "context-1", contentDigest: "sha256:context" };
    const test = fixture();
    test.client.messages = async () => [
      {
        info: {
          id: "message-group",
          sessionID: "session-1",
          role: "user",
          time: { created: 11 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
        parts: [
          {
            id: "part-group",
            sessionID: "session-1",
            messageID: "message-group",
            type: "text",
            text: [
              "<clawchat_turn_context>",
              JSON.stringify({
                origin: "clawchat",
                message_id: batchIdentity.messageId,
                content_digest: batchIdentity.contentDigest,
                group_batch: { messages: [{ message_id: "group-1", content_digest: "sha256:group" }] },
                recent_group_context: [{ message_id: "context-1", content_digest: "sha256:context" }],
              }),
              "</clawchat_turn_context>",
              "group input",
            ].join("\n"),
          },
        ],
      },
    ];
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const binding = { kind: "opencode" as const };

    await expect(adapter.reconcileInput?.(binding, "session-1", batchIdentity)).resolves.toMatchObject({
      outcome: "accepted",
      identity: { actionable: [batchIdentity], context: [contextIdentity] },
    });
    await expect(adapter.reconcileInput?.(binding, "session-1", contextIdentity)).resolves.toMatchObject({
      outcome: "accepted",
      identity: { actionable: [batchIdentity], context: [contextIdentity] },
    });
    await expect(
      adapter.reconcileInput?.(binding, "session-1", {
        messageId: batchIdentity.messageId,
        contentDigest: "sha256:different-content",
      }),
    ).resolves.toMatchObject({ outcome: "absent", receipts: { complete: true } });

    const history = await adapter.readActivity?.(binding, "session-1");
    expect(history?.activities[0]?.inputIdentity).toMatchObject({
      actionable: [batchIdentity],
      context: [contextIdentity],
    });

    test.client.messages = async () => {
      throw new Error("native history unavailable");
    };
    await expect(adapter.reconcileInput?.(binding, "session-1", batchIdentity)).resolves.toEqual({
      outcome: "unknown",
    });
    test.client.messages = async () => [
      {
        info: {
          id: "legacy-message",
          sessionID: "session-1",
          role: "user",
          time: { created: 12 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
        parts: [
          {
            id: "legacy-part",
            sessionID: "session-1",
            messageID: "legacy-message",
            type: "text",
            text: '<clawchat_turn_context>\n{"origin":"clawchat","message_id":"group-1"}\n</clawchat_turn_context>\nlegacy',
          },
        ],
      },
    ];
    await expect(adapter.reconcileInput?.(binding, "session-1", batchIdentity)).resolves.toMatchObject({
      outcome: "unknown",
      receipts: { complete: false },
    });
    test.client.messages = async () => [
      {
        info: {
          id: "malformed-group-message",
          sessionID: "session-1",
          role: "user",
          time: { created: 13 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
        parts: [
          {
            id: "malformed-group-part",
            sessionID: "session-1",
            messageID: "malformed-group-message",
            type: "text",
            text: [
              "<clawchat_turn_context>",
              JSON.stringify({
                origin: "clawchat",
                message_id: batchIdentity.messageId,
                content_digest: batchIdentity.contentDigest,
                group_batch: { messages: [{ message_id: "other", content_digest: "digest-other" }] },
              }),
              "</clawchat_turn_context>",
              "malformed group input",
            ].join("\n"),
          },
        ],
      },
    ];
    await expect(adapter.reconcileInput?.(binding, "session-1", batchIdentity)).resolves.toMatchObject({
      outcome: "unknown",
      receipts: { complete: false },
    });
    await adapter.close?.();
  });

  it("discovers user-invocable Skills and runs the selected Skill as a native Session command", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const binding = { kind: "opencode" as const };
    const invalidated = mock(() => undefined);
    adapter.onSkillsChanged?.(invalidated);

    const skills = await adapter.listSkills?.(binding, runtimeWorkspace);
    expect(skills).toEqual([
      {
        id: "opencode:grill-with-docs",
        name: "grill-with-docs",
        description: "Challenge a proposal against primary documentation",
      },
    ]);

    const session = await adapter.start(binding, startContext());
    for await (const _activity of session.prompt({
      prompt: "  /grill-with-docs Review the Skill design  ",
      skill: skills?.[0],
      workspace: runtimeWorkspace,
    })) {
      // Drain the completed native turn.
    }

    expect(test.prompts).toEqual([]);
    expect(test.commands).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        directory,
        command: "grill-with-docs",
        arguments: "Review the Skill design",
      }),
    ]);

    const otherSession = await adapter.start(
      binding,
      startContext({ sessionId: "connect-session-2", runtimeSessionId: null }),
    );
    await expect(
      (async () => {
        for await (const _activity of otherSession.prompt({
          prompt: "/grill-with-docs Must not cross workspaces",
          skill: skills?.[0],
          workspace: { ...runtimeWorkspace, projectId: "project-2", workingDirectory: "/other-repo" },
        })) {
          // A Skill discovered for one workspace is not valid in another.
        }
      })(),
    ).rejects.toThrow("OpenCode Skill is no longer available: grill-with-docs");
    expect(test.commands).toHaveLength(1);
    expect(invalidated).not.toHaveBeenCalled();

    test.client.runCommand = async () => {
      throw new Error("Skill permission denied");
    };
    await expect(
      (async () => {
        for await (const _activity of session.prompt({
          prompt: "/grill-with-docs Retry after permission changed",
          skill: skills?.[0],
          workspace: runtimeWorkspace,
        })) {
          // Native Skill failures invalidate the cached catalog for retry.
        }
      })(),
    ).rejects.toThrow("Skill permission denied");
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("discovers ordinary runtime commands and invokes a selected command natively", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const binding = { kind: "opencode" as const };

    const commands = await adapter.listCommands?.(binding, runtimeWorkspace);
    expect(commands).toEqual([
      {
        id: "opencode-command:compact",
        name: "compact",
        description: "Compact the Session",
      },
    ]);

    const session = await adapter.start(binding, startContext());
    for await (const _activity of session.prompt({
      prompt: "/compact keep the important context",
      command: commands?.[0],
      workspace: runtimeWorkspace,
    })) {
      // Drain the completed native turn.
    }

    expect(test.commands).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        directory,
        command: "compact",
        arguments: "keep the important context",
      }),
    ]);
  });

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
    test.sessions.push(
      nativeSession({
        id: "isolated-1",
        directory:
          "/tmp/.clawchat-connect/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/cccccccccccccccccccccccc",
      }),
    );
    expect(
      (await adapter.discoverAllThreads?.(binding))?.find((thread) => thread.runtimeThreadId === "isolated-1"),
    ).toMatchObject({
      workspaceKind: "transient",
      workspaceIdentity: { kind: "transient" },
    });
    await adapter.close?.();
  });

  it("maps native history into stable runtime-neutral Activity and deletes natively", async () => {
    const test = fixture();
    test.sessions.push(nativeSession({ id: "grandchild-1", parentID: "child-1", title: "Grandchild" }));
    const nativeHistory = history();
    test.client.messages = async (sessionID) =>
      sessionID === "child-1"
        ? [
            {
              info: {
                id: "child-message",
                sessionID: "child-1",
                role: "user",
                time: { created: 13 },
                agent: "explore",
                model: { providerID: "anthropic", modelID: "claude-sonnet" },
              },
              parts: [
                {
                  id: "child-part",
                  sessionID: "child-1",
                  messageID: "child-message",
                  type: "text",
                  text: "child work",
                },
              ],
            },
          ]
        : sessionID === "grandchild-1"
          ? [
              {
                info: {
                  id: "grandchild-message",
                  sessionID: "grandchild-1",
                  role: "user",
                  time: { created: 14 },
                  agent: "explore",
                  model: { providerID: "anthropic", modelID: "claude-sonnet" },
                },
                parts: [
                  {
                    id: "grandchild-part",
                    sessionID: "grandchild-1",
                    messageID: "grandchild-message",
                    type: "text",
                    text: "nested child work",
                  },
                ],
              },
            ]
          : nativeHistory;
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const binding = { kind: "opencode" as const };

    const first = await adapter.readActivity?.(binding, "session-1");
    const second = await adapter.readActivity?.(binding, "session-1");
    expect(second).toEqual(first);
    expect(first).toMatchObject({ completeness: "partial", limitations: ["correlation", "ordering"] });
    expect(first?.activities.slice(0, 4).map(({ id, position, kind, text }) => ({ id, position, kind, text }))).toEqual(
      [
        { id: "message-user:part-user", position: "0.1", kind: "user", text: "inspect" },
        { id: "message-assistant:part-reasoning", position: "1.1", kind: "reasoning", text: "checking" },
        { id: "message-assistant:part-tool", position: "1.2", kind: "command", text: "Run pwd\n\n/repo" },
        { id: "message-assistant:part-answer", position: "1.3", kind: "assistant", text: "done" },
      ],
    );
    const child = first?.activities.find((activity) => activity.id === "subagent:p6QCSiqLQja_67w_fVJy-U");
    expect(child).toMatchObject({ kind: "subagent", text: "Child" });
    expect(JSON.stringify(first?.activities)).not.toContain("session:child-1");
    expect(JSON.stringify(first?.activities)).not.toContain('"runtimeThreadId"');
    expect(child?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "child-message:child-part",
          position: "0.1",
          kind: "user",
          text: "child work",
        }),
        expect.objectContaining({
          id: "subagent:lzdRZo2nD2anE44JhpAUKS",
          kind: "subagent",
          children: [
            expect.objectContaining({
              id: "grandchild-message:grandchild-part",
              text: "nested child work",
            }),
          ],
        }),
      ]),
    );
    nativeHistory.push({
      info: {
        id: "message-external",
        sessionID: "session-1",
        role: "user",
        time: { created: 15 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
      },
      parts: [
        {
          id: "part-external",
          sessionID: "session-1",
          messageID: "message-external",
          type: "text",
          text: "external edit",
        },
      ],
    });
    expect((await adapter.readActivity?.(binding, "session-1"))?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external:message-external",
          text: "OpenCode Session was modified by another client.",
        }),
      ]),
    );

    await adapter.deleteThread?.(binding, "session-1");
    expect(test.deletes()).toBe(1);
    await adapter.close?.();
  });

  it("does not guess a child Session's parent activity from subtask array order", async () => {
    const test = fixture();
    const assistantMessage = history()[1];
    if (!assistantMessage) throw new Error("history fixture is missing its assistant message");
    test.client.messages = async (sessionID) =>
      sessionID === "session-1"
        ? [
            {
              info: assistantMessage.info,
              parts: [
                {
                  id: "subtask-without-native-child-id",
                  sessionID: "session-1",
                  messageID: "message-assistant",
                  type: "subtask",
                  prompt: "delegate",
                  description: "Possibly unrelated task",
                  agent: "explore",
                },
              ],
            },
          ]
        : [];
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });

    const snapshot = await adapter.readActivity?.({ kind: "opencode" }, "session-1");

    expect(
      snapshot?.activities.find((activity) => activity.id.endsWith("subtask-without-native-child-id"))?.children,
    ).toBe(undefined);
    expect(snapshot?.activities).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "subagent:p6QCSiqLQja_67w_fVJy-U", kind: "subagent" })]),
    );
    await adapter.close?.();
  });

  it("does not confirm native deletion when OpenCode reports that nothing was deleted", async () => {
    const test = fixture();
    test.client.deleteSession = async () => false;
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });

    await expect(adapter.deleteThread?.({ kind: "opencode" }, "session-1")).rejects.toThrow(
      "OpenCode Session deletion was not confirmed",
    );
    await adapter.close?.();
  });

  it("keeps unknown native parts displayable without exposing their private payload", async () => {
    const test = fixture();
    const userMessage = history()[0];
    if (!userMessage) throw new Error("history fixture is missing its user message");
    test.client.messages = async (sessionID) =>
      sessionID === "session-1"
        ? [
            {
              info: userMessage.info,
              parts: [
                {
                  id: "snapshot-part",
                  sessionID: "session-1",
                  messageID: "message-user",
                  type: "snapshot",
                  snapshot: "private-native-snapshot",
                },
              ],
            },
          ]
        : [];
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });

    const snapshot = await adapter.readActivity?.({ kind: "opencode" }, "session-1");

    expect(snapshot?.activities[0]).toMatchObject({
      id: "message-user:snapshot-part",
      kind: "unknown",
      text: "OpenCode snapshot activity",
    });
    expect(JSON.stringify(snapshot?.activities)).not.toContain("private-native-snapshot");
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
      startContext({
        runtimeSessionId: null,
        onRuntimeSessionId: async (value) => {
          attached = value;
        },
      }),
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
        {
          kind: "file",
          url: "https://media.example/readme.pdf",
          stagedPath: "/tmp/readme.pdf",
          name: "readme.pdf",
          mime: "application/pdf",
        },
        {
          kind: "audio",
          url: "https://media.example/audio.mp3",
          stagedPath: "/tmp/audio.mp3",
          name: "audio.mp3",
          mime: "audio/mpeg",
        },
        {
          kind: "video",
          url: "https://media.example/video.mp4",
          stagedPath: "/tmp/video.mp4",
          name: "video.mp4",
          mime: "video/mp4",
        },
      ],
      workspace: runtimeWorkspace,
      sessionOptions: { agent: "build", model: "anthropic/claude-sonnet", variant: "high" },
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
          { type: "file", mime: "application/pdf", filename: "readme.pdf", url: "file:///tmp/readme.pdf" },
          { type: "file", mime: "audio/mpeg", filename: "audio.mp3", url: "file:///tmp/audio.mp3" },
          { type: "file", mime: "video/mp4", filename: "video.mp4", url: "file:///tmp/video.mp4" },
        ],
      },
    ]);
    expect(
      activities.some((activity) => activity.id === "message-assistant:part-answer" && activity.text === "done"),
    ).toBe(true);
    await session.close();
    await adapter.close?.();
  });

  it("generates OpenCode-compatible native message IDs for ordinary prompts", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());

    for await (const _activity of session.prompt({ prompt: "hello", workspace: runtimeWorkspace })) {
      // Drain the completed native turn.
    }

    expect(test.prompts).toHaveLength(1);
    expect(test.prompts[0]?.messageID).toMatch(/^msg[_-]/u);
    await session.close();
    await adapter.close?.();
  });

  it("accepts Session-scoped OpenCode events that omit the optional directory envelope", async () => {
    const test = fixture();
    test.client.promptAsync = async (input) => {
      test.prompts.push(input);
      test.events.push({
        payload: {
          id: "event-part-without-directory",
          type: "message.part.updated",
          properties: { sessionID: input.sessionID, part: history()[1]?.parts[2], time: 14 },
        },
      } as unknown as GlobalEvent);
      test.events.push({
        payload: {
          id: "event-idle-without-directory",
          type: "session.idle",
          properties: { sessionID: input.sessionID },
        },
      } as unknown as GlobalEvent);
    };
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());

    const activities = [];
    for await (const activity of session.prompt({ prompt: "hello", workspace: runtimeWorkspace })) {
      activities.push(activity);
    }

    expect(activities.some((activity) => activity.kind === "error")).toBe(false);
    expect(activities.some((activity) => activity.kind === "assistant" && activity.text === "done")).toBe(true);
    await session.close();
    await adapter.close?.();
  });

  it("keeps an atomically accepted Turn Submission terminal when OpenCode later rejects its MIME", async () => {
    const root = await mkdtemp(join(tmpdir(), "connect-opencode-provider-error-"));
    const config = upsertAgentBinding(defaultConfig(), "open", { kind: "opencode" });
    config.stateDbPath = join(root, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    const projects = new ProjectCatalog(store);
    const project = await projects.add(root);
    await store.upsertRuntimeSession({
      chatId: "chat",
      sessionId: "connect-session",
      agentId: "open",
      projectId: project.projectId,
      runtimeSessionId: "session-1",
      isCurrent: true,
    });
    const current = await store.getCurrentRuntimeSession("chat", "open");
    if (!current) throw new Error("current OpenCode Session fixture is missing");

    const test = fixture();
    test.sessions[0] = nativeSession({ directory: root });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let rejectProvider!: () => void;
    const rejected = new Promise<void>((resolve) => {
      rejectProvider = resolve;
    });
    test.client.promptAsync = async (input) => {
      test.prompts.push(input);
      providerStarted();
      await rejected;
      throw new Error("provider rejected unsupported MIME application/pdf");
    };
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const runtimeAdapters = new RuntimeAdapterRegistry([{ kind: "opencode", create: () => adapter }]);
    const transcriptProjection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters });
    const runtime = new ConnectRuntime({
      agentId: "open",
      config,
      configPath: join(root, "config.json"),
      stateStore: store,
      wsClient: {
        uploadMedia: async () => {
          throw new Error("unexpected upload");
        },
        sendMessageEnvelope: async () => ({ payload: {} }),
      } as unknown as ConnectWsClient,
      projects,
      runtimeAdapters,
      transcriptProjection,
    });

    const rollback = mock(async () => undefined);
    const transfer = mock(() => undefined);
    const acceptedMedia = {
      kind: "file" as const,
      url: "https://media.example/document.pdf",
      stagedPath: join(root, "document.pdf"),
      name: "document.pdf",
      mime: "application/pdf",
    };
    const accept = mock(async (sessionRef: string, prompt: string) => ({
      accepted: true as const,
      ...(await runtime.enqueueClientTurn(sessionRef, prompt, [acceptedMedia])),
    }));
    const capability: TurnSubmissionCapability = {
      prompt: { allowed: true, required: false, maxCharacters: 64_000 },
      attachments: {
        allowedKinds: ["file"],
        allowedMediaTypes: ["application/pdf"],
        maxCount: 1,
        maxBytesEach: 1024,
        maxBytesTotal: 1024,
      },
    };
    const submissions = new TurnSubmission({
      capabilityFor: async () => capability,
      staging: { stage: async () => ({ rollback, transfer }) },
      accept,
    });

    const accepted = await submissions.submit({
      submissionId: "submission-pdf",
      sessionRef: current.sessionRef,
      prompt: "inspect",
      attachments: [
        {
          name: "document.pdf",
          mime: "application/pdf",
          size: 4,
          readBytes: async () => new TextEncoder().encode("data"),
        },
      ],
    });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledTimes(1);
    await started;
    expect(runtime.activeClientTurnId(current.sessionRef)).toBe(accepted.turnId);
    expect(await store.listTranscriptBlocks(current.sessionRef)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "error" })]),
    );

    rejectProvider();
    let blocks = await store.listTranscriptBlocks(current.sessionRef);
    for (let attempt = 0; attempt < 100 && !blocks.some((block) => block.type === "error"); attempt += 1) {
      await Bun.sleep(0);
      blocks = await store.listTranscriptBlocks(current.sessionRef);
    }
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          state: "error",
          message: "Connect Client turn failed: provider rejected unsupported MIME application/pdf",
        }),
      ]),
    );
    expect(accept).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    await runtime.dispose();
    await runtimeAdapters.close();
    await store.close();
  });

  it("leaves native agent, model, and variant defaults unset", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext({ runtimeSessionId: null }));
    for await (const _activity of session.prompt({
      prompt: "inspect",
      workspace: runtimeWorkspace,
    })) {
      // Consume the completed turn.
    }
    expect(test.prompts[0]).not.toHaveProperty("agent");
    expect(test.prompts[0]).not.toHaveProperty("model");
    expect(test.prompts[0]).not.toHaveProperty("variant");
    await adapter.close?.();
  });

  it("routes owned permission requests through the originating Interaction and aborts natively", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const requests: RuntimeInteractionRequest[] = [];
    let deliveryConfirmation: Promise<void> | null = null;
    const session = await adapter.start({ kind: "opencode" }, startContext());

    const result = session.prompt({
      prompt: "run",
      workspace: runtimeWorkspace,
      turnId: "turn-1",
      turnOrigin: "client",
      metadata: { sessionRef: "ABCDEFGH" },
      interactionPort: {
        request: async (request, context) => {
          requests.push(request);
          deliveryConfirmation = context.deliveryConfirmation;
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
    await expect(deliveryConfirmation as Promise<void> | null).resolves.toBeUndefined();
    await pendingActivity;
    await session.close();
    await adapter.close?.();
  });

  it("maps approve-once and deny exactly once while ignoring a foreign Session request", async () => {
    for (const testCase of [
      { optionId: "approve-once" as const, nativeReply: "once" },
      { optionId: "deny" as const, nativeReply: "reject" },
    ]) {
      const test = fixture();
      const requests: RuntimeInteractionRequest[] = [];
      const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
      const session = await adapter.start(
        { kind: "opencode" },
        startContext({
          sessionId: `connect-${testCase.optionId}`,
        }),
      );
      test.client.promptAsync = async () => {
        for (const [id, sessionID] of [
          ["foreign-permission", "another-session"],
          ["owned-permission", "session-1"],
        ]) {
          test.events.push({
            directory,
            payload: {
              id: `event-${id}`,
              type: "permission.asked",
              properties: {
                id,
                sessionID,
                permission: "bash",
                patterns: ["git status"],
                metadata: { command: "git status" },
                always: [],
              },
            },
          } as GlobalEvent);
        }
      };
      const iterator = session
        .prompt({
          prompt: "run",
          workspace: runtimeWorkspace,
          turnId: `turn-${testCase.optionId}`,
          turnOrigin: "client",
          metadata: { sessionRef: "ABCDEFGH" },
          interactionPort: {
            request: async (request) => {
              requests.push(request);
              return { kind: "approval", optionId: testCase.optionId };
            },
          },
        })
        [Symbol.asyncIterator]();
      const pending = iterator.next();
      await test.permissionReplied;

      expect(requests).toHaveLength(1);
      expect(test.permissionReplies).toEqual([testCase.nativeReply]);
      await session.cancel?.();
      await pending;
      await adapter.close?.();
    }
  });

  it("fails Interaction delivery when OpenCode does not confirm a permission response", async () => {
    const test = fixture();
    let attempted!: () => void;
    const responseAttempted = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    test.client.replyPermission = async () => {
      attempted();
      return false;
    };
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());
    let deliveryConfirmation: Promise<void> | null = null;
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-unconfirmed-permission",
          type: "permission.asked",
          properties: {
            id: "unconfirmed-permission",
            sessionID: "session-1",
            permission: "bash",
            patterns: ["git status"],
            metadata: { command: "git status" },
            always: [],
          },
        },
      } as GlobalEvent);
    };
    const iterator = session
      .prompt({
        prompt: "run",
        workspace: runtimeWorkspace,
        turnId: "turn-unconfirmed-permission",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (_request, context) => {
            deliveryConfirmation = context.deliveryConfirmation;
            return { kind: "approval", optionId: "approve-once" };
          },
        },
      })
      [Symbol.asyncIterator]();
    const activity = iterator.next();
    await responseAttempted;

    await expect(deliveryConfirmation as Promise<void> | null).rejects.toThrow(
      "OpenCode permission response was not confirmed",
    );
    await expect(activity).resolves.toMatchObject({
      value: expect.objectContaining({ kind: "error", text: expect.stringContaining("was not confirmed") }),
    });
    await iterator.next();
    await adapter.close?.();
  });

  it("rejects a pending native Interaction before aborting its Session", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start(
      { kind: "opencode" },
      startContext({
        sessionId: "connect-cancel",
      }),
    );
    let interactionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      interactionStarted = resolve;
    });
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-cancel-permission",
          type: "permission.asked",
          properties: {
            id: "cancel-permission",
            sessionID: "session-1",
            permission: "bash",
            patterns: ["git status"],
            metadata: { command: "git status" },
            always: [],
          },
        },
      } as GlobalEvent);
    };
    const iterator = session
      .prompt({
        prompt: "run",
        workspace: runtimeWorkspace,
        turnId: "turn-cancel",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (_request, context) => {
            interactionStarted();
            await new Promise<void>((resolve) =>
              context.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            throw new Error("cancelled");
          },
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await started;
    await session.cancel?.();

    expect(test.nativeCalls.slice(-2)).toEqual(["permission:reject", "abort"]);
    expect(test.permissionReplies).toEqual(["reject"]);
    await pending;
    await adapter.close?.();
  });

  it("still aborts after an unconfirmed native Interaction rejection and reports the failure", async () => {
    const test = fixture();
    test.client.replyPermission = async (_requestID, _directory, reply) => {
      test.nativeCalls.push(`permission:${reply}`);
      return false;
    };
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());
    let interactionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      interactionStarted = resolve;
    });
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-unconfirmed-cancel",
          type: "permission.asked",
          properties: {
            id: "unconfirmed-cancel",
            sessionID: "session-1",
            permission: "bash",
            patterns: ["git status"],
            metadata: { command: "git status" },
            always: [],
          },
        },
      } as GlobalEvent);
    };
    const iterator = session
      .prompt({
        prompt: "run",
        workspace: runtimeWorkspace,
        turnId: "turn-unconfirmed-cancel",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (_request, context) => {
            interactionStarted();
            await new Promise<void>((resolve) =>
              context.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            throw new Error("cancelled");
          },
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await started;

    await expect(session.cancel?.()).rejects.toThrow("OpenCode permission rejection was not confirmed");
    expect(test.nativeCalls.slice(-2)).toEqual(["permission:reject", "abort"]);
    await pending;
    await iterator.next();
    await adapter.close?.();
  });

  it("expires a pending Runtime Interaction when the owned Server event stream fails", async () => {
    const test = fixture();
    let failEvents!: () => void;
    const failed = new Promise<void>((resolve) => {
      failEvents = resolve;
    });
    let emitPermission!: () => void;
    const permissionReady = new Promise<void>((resolve) => {
      emitPermission = resolve;
    });
    let eventConnection = 0;
    test.client.events = async function* (_signal, onConnected) {
      onConnected?.();
      eventConnection += 1;
      if (eventConnection === 1) {
        await permissionReady;
        yield {
          directory,
          payload: {
            id: "event-permission",
            type: "permission.asked",
            properties: {
              id: "permission-pending",
              sessionID: "session-1",
              permission: "bash",
              patterns: ["git status"],
              metadata: { command: "git status" },
              always: [],
            },
          },
        } as GlobalEvent;
      }
      await failed;
      throw new Error("server exited");
    };
    test.client.promptAsync = async () => {
      emitPermission();
    };
    let interactionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      interactionStarted = resolve;
    });
    let interactionAborted = false;
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());
    const iterator = session
      .prompt({
        prompt: "run",
        workspace: runtimeWorkspace,
        turnId: "turn-exit",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (_request, context) => {
            interactionStarted();
            await new Promise<void>((resolve) => {
              context.signal?.addEventListener(
                "abort",
                () => {
                  interactionAborted = true;
                  resolve();
                },
                { once: true },
              );
            });
            throw new Error("interaction expired");
          },
        },
      })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    await started;
    failEvents();

    let result = await next;
    while (!result.done && result.value.kind !== "error") result = await iterator.next();
    expect(result).toMatchObject({
      done: false,
      value: { kind: "error", text: expect.stringContaining("server exited") },
    });
    expect(interactionAborted).toBe(true);
    expect(test.permissionReplies).toEqual([]);
    await adapter.close?.();
  });

  it("restarts a failed Binding Server for a later Session without replaying the accepted prompt", async () => {
    const first = fixture();
    const second = fixture();
    let failEvents!: () => void;
    const failed = new Promise<void>((resolve) => {
      failEvents = resolve;
    });
    first.client.events = async function* (_signal, onConnected) {
      onConnected?.();
      yield* [] as GlobalEvent[];
      await failed;
      throw new Error("first server exited");
    };
    let firstPromptStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstPromptStarted = resolve;
    });
    first.client.promptAsync = async (input) => {
      first.prompts.push(input);
      firstPromptStarted();
    };
    let firstClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      firstClosed = resolve;
    });
    first.client.close = async () => {
      firstClosed();
    };
    const clients = [first.client, second.client];
    const adapter = createOpenCodeRuntimeAdapter({
      createServer: async () => {
        const client = clients.shift();
        if (!client) throw new Error("unexpected third Server");
        return client;
      },
    });
    const context = startContext({ sessionId: "connect-restart" });
    const firstSession = await adapter.start({ kind: "opencode" }, context);
    const firstIterator = firstSession
      .prompt({
        prompt: "first",
        workspace: runtimeWorkspace,
        turnId: "turn-first",
      })
      [Symbol.asyncIterator]();
    let firstResultPromise = firstIterator.next();
    await firstStarted;
    failEvents();
    let firstResult = await firstResultPromise;
    let firstError: IteratorResult<RuntimeActivity> | null = null;
    while (!firstResult.done) {
      if (firstResult.value.kind === "error") firstError = firstResult;
      firstResultPromise = firstIterator.next();
      firstResult = await firstResultPromise;
    }
    expect(firstError).toMatchObject({ done: false, value: { kind: "error" } });
    await closed;

    for await (const _activity of firstSession.prompt({
      prompt: "second",
      workspace: runtimeWorkspace,
    })) {
      // Consume the recovered turn.
    }
    expect(first.prompts.map((prompt) => prompt.parts)).toEqual([[{ type: "text", text: "first" }]]);
    expect(second.prompts.map((prompt) => prompt.parts)).toEqual([[{ type: "text", text: "second" }]]);
    await adapter.close?.();
  });

  it("owns independent OpenCode Server clients for two Binding identities", async () => {
    const work = fixture();
    const review = fixture();
    const clients = new Map([
      ["work", work.client],
      ["review", review.client],
    ]);
    const definitionRegistry = new RuntimeAdapterRegistry([
      {
        kind: "opencode",
        create: () =>
          createOpenCodeRuntimeAdapter({
            createServer: async (binding) => {
              const id = binding.env?.CLAWCHAT_CONNECT_AGENT_ID ?? "";
              const client = clients.get(id);
              if (!client) throw new Error(`missing fixture for ${id}`);
              return client;
            },
          }),
      },
    ]);
    const workBinding = {
      kind: "opencode",
      env: { CLAWCHAT_CONNECT_AGENT_ID: "work" },
    } as const;
    const reviewBinding = {
      kind: "opencode",
      env: { CLAWCHAT_CONNECT_AGENT_ID: "review" },
    } as const;

    await Promise.all([definitionRegistry.prepare(workBinding), definitionRegistry.prepare(reviewBinding)]);
    expect(work.closes()).toBe(0);
    expect(review.closes()).toBe(0);
    await definitionRegistry.close();
    expect(work.closes()).toBe(1);
    expect(review.closes()).toBe(1);
  });

  it("routes structured OpenCode questions and confirms their native answers", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());
    let deliveryConfirmation: Promise<void> | null = null;
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-question",
          type: "question.asked",
          properties: {
            id: "question-request-1",
            sessionID: "session-1",
            questions: [
              {
                question: "Choose a target",
                header: "Target",
                options: [
                  { label: "Tests", description: "Only tests" },
                  { label: "All", description: "Everything" },
                ],
                multiple: false,
                custom: true,
              },
              {
                question: "Add a note",
                header: "Note",
                options: [],
                multiple: false,
                custom: true,
              },
            ],
          },
        },
      } as GlobalEvent);
    };
    const iterator = session
      .prompt({
        prompt: "ask",
        workspace: runtimeWorkspace,
        turnId: "turn-question",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (request, context) => {
            expect(request).toMatchObject({
              kind: "user-input",
              questions: [
                { id: "question-1", prompt: "Choose a target" },
                { id: "question-2", prompt: "Add a note" },
              ],
            });
            deliveryConfirmation = context.deliveryConfirmation;
            return {
              kind: "user-input",
              answers: { "question-1": ["All"], "question-2": ["ship it"] },
            };
          },
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await test.questionReplied;

    expect(test.questionReplies).toEqual([[["All"], ["ship it"]]]);
    await expect(deliveryConfirmation as Promise<void> | null).resolves.toBeUndefined();
    await session.cancel?.();
    await pending;
    await adapter.close?.();
  });

  it("rejects a failed question Interaction instead of submitting empty answers", async () => {
    const test = fixture();
    let rejected!: () => void;
    const rejectionAttempted = new Promise<void>((resolve) => {
      rejected = resolve;
    });
    test.client.rejectQuestion = async () => {
      test.nativeCalls.push("question:reject");
      rejected();
      return true;
    };
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());
    let deliveryConfirmation: Promise<void> | null = null;
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-rejected-question",
          type: "question.asked",
          properties: {
            id: "rejected-question",
            sessionID: "session-1",
            questions: [
              {
                question: "Choose a target",
                header: "Target",
                options: [],
                multiple: false,
                custom: true,
              },
            ],
          },
        },
      } as GlobalEvent);
    };
    const iterator = session
      .prompt({
        prompt: "ask",
        workspace: runtimeWorkspace,
        turnId: "turn-rejected-question",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (_request, context) => {
            deliveryConfirmation = context.deliveryConfirmation;
            throw new Error("interaction expired");
          },
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await rejectionAttempted;

    expect(test.questionReplies).toEqual([]);
    expect(test.nativeCalls).toContain("question:reject");
    await expect(deliveryConfirmation as Promise<void> | null).resolves.toBeUndefined();
    await session.cancel?.();
    await pending;
    await iterator.next();
    await adapter.close?.();
  });

  it("fails Interaction delivery when OpenCode does not confirm a question response", async () => {
    const test = fixture();
    let attempted!: () => void;
    const responseAttempted = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    test.client.replyQuestion = async () => {
      attempted();
      return false;
    };
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());
    let deliveryConfirmation: Promise<void> | null = null;
    test.client.promptAsync = async () => {
      test.events.push({
        directory,
        payload: {
          id: "event-unconfirmed-question",
          type: "question.asked",
          properties: {
            id: "unconfirmed-question",
            sessionID: "session-1",
            questions: [
              {
                question: "Choose a target",
                header: "Target",
                options: [],
                multiple: false,
                custom: true,
              },
            ],
          },
        },
      } as GlobalEvent);
    };
    const iterator = session
      .prompt({
        prompt: "ask",
        workspace: runtimeWorkspace,
        turnId: "turn-unconfirmed-question",
        turnOrigin: "client",
        metadata: { sessionRef: "ABCDEFGH" },
        interactionPort: {
          request: async (_request, context) => {
            deliveryConfirmation = context.deliveryConfirmation;
            return { kind: "user-input", answers: { "question-1": ["Tests"] } };
          },
        },
      })
      [Symbol.asyncIterator]();
    const activity = iterator.next();
    await responseAttempted;

    await expect(deliveryConfirmation as Promise<void> | null).rejects.toThrow(
      "OpenCode question response was not confirmed",
    );
    await expect(activity).resolves.toMatchObject({
      value: expect.objectContaining({ kind: "error", text: expect.stringContaining("was not confirmed") }),
    });
    await iterator.next();
    await adapter.close?.();
  });

  it("reconnects the global event stream and reconciles active Session history", async () => {
    const test = fixture();
    let settlePromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      settlePromptStarted = resolve;
    });
    test.client.promptAsync = async () => {
      settlePromptStarted();
    };
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());
    const iterator = session
      .prompt({
        prompt: "continue",
        workspace: runtimeWorkspace,
      })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    await promptStarted;
    test.events.disconnect();
    await expect(next).resolves.toMatchObject({
      done: false,
      value: { id: "message-user:part-user", source: "history" },
    });
    await session.cancel?.();
    await adapter.close?.();
  });

  it("fails closed for unavailable saved selections and file permissions outside trusted roots", async () => {
    const test = fixture();
    const adapter = createOpenCodeRuntimeAdapter({ createServer: async () => test.client });
    const session = await adapter.start({ kind: "opencode" }, startContext());

    await expect(async () => {
      for await (const _activity of session.prompt({
        prompt: "run",
        workspace: runtimeWorkspace,
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
            permission: "external_directory",
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
        workspace: runtimeWorkspace,
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
