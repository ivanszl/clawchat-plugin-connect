import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/client-interface/session-catalog";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimePrompt, ConnectRuntimeStartContext, RuntimeActivity } from "../src/runtime/types";
import { WorkBuddyPromptTransportError } from "../src/runtime/workbuddy-acp-client";
import { createWorkBuddyRuntimeAdapter, type WorkBuddyRuntimeSource } from "../src/runtime/workbuddy-adapter";
import { WorkBuddyDiscoveryError, type WorkBuddyDiscoveryFailureCode } from "../src/runtime/workbuddy-task-discovery";
import { createStateStore } from "../src/state";
import type { WorkBuddyAgentBindingConfig } from "../src/types";

const binding: WorkBuddyAgentBindingConfig = { kind: "workbuddy", profile: "workbuddy-ai" };
const taskId = "00000000-0000-4000-8000-000000000001";
const workspace = "/private/tmp/workbuddy-adapter-task";

const history = {
  activities: [
    {
      id: "workbuddy:user:native-message",
      position: "0.1",
      parentId: null,
      kind: "user" as const,
      text: "desktop question",
      state: "complete" as const,
      source: "history" as const,
    },
    {
      id: "workbuddy:reasoning:native-message",
      position: "0.2",
      parentId: null,
      kind: "reasoning" as const,
      text: "desktop thought",
      state: "complete" as const,
      source: "history" as const,
    },
    {
      id: "workbuddy:assistant:native-message",
      position: "0.3",
      parentId: null,
      kind: "assistant" as const,
      text: "desktop answer",
      state: "complete" as const,
      source: "history" as const,
    },
  ],
  completeness: "complete" as const,
  limitations: [],
};

function source(): WorkBuddyRuntimeSource {
  return {
    listTasks: async () => [
      {
        id: taskId,
        title: "Authoritative desktop task",
        workspace,
        updatedAt: 1_786_000_000_000,
      },
    ],
    attachTask: async () => history,
  };
}

describe("WorkBuddy Runtime Adapter", () => {
  it("discovers WorkBuddy AI Tasks through the Runtime Thread catalog", async () => {
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: source });

    await expect(adapter.discoverAllThreads?.(binding)).resolves.toEqual([
      {
        runtimeThreadId: taskId,
        name: "Authoritative desktop task",
        updatedAt: 1_786_000_000_000,
        workingDirectory: workspace,
        workspaceKind: "persistent",
        workspaceIdentity: { key: workspace, kind: "persistent", localRoot: workspace },
      },
    ]);
    await expect(
      adapter.discoverThreads?.(binding, {
        projectId: null,
        workingDirectory: workspace,
        additionalDirectories: [],
        skipGitRepoCheck: false,
      }),
    ).resolves.toHaveLength(1);
  });

  it("attaches the selected Task and returns deterministic complete Runtime Activity history", async () => {
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: source });

    const first = await adapter.readActivity?.(binding, taskId);
    const refreshed = await adapter.readActivity?.(binding, taskId);

    expect(first).toEqual(history);
    expect(refreshed).toEqual(first);
  });

  it("refreshes authoritative history into Transcript Projection without duplicate messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbuddy-adapter-projection-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: source });
    const registry = new RuntimeAdapterRegistry([{ kind: "workbuddy", create: () => adapter }]);
    const config = defaultConfig();
    config.defaultAgent = "desktop";
    config.agents = { desktop: binding };
    try {
      await store.upsertRuntimeSession({
        chatId: "client-catalog",
        sessionId: "connect-session",
        agentId: "desktop",
        runtimeSessionId: taskId,
        name: "Authoritative desktop task",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("client-catalog", "desktop");
      if (!session) throw new Error("fixture Session was not created");
      const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });

      await projection.reconcile(session);
      await projection.reconcile(session);

      const blocks = await store.listTranscriptBlocks(session.sessionRef);
      expect(blocks.map((block) => block.plainText)).toEqual(["desktop question", "desktop thought", "desktop answer"]);
      expect(new Set(blocks.map((block) => block.id)).size).toBe(3);
      expect(projection.completeness(session.sessionRef)).toBe("complete");
    } finally {
      await registry.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("converges a Connect-authored user block and streaming WorkBuddy output onto native Activity identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbuddy-adapter-live-projection-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: source });
    const registry = new RuntimeAdapterRegistry([{ kind: "workbuddy", create: () => adapter }]);
    const config = defaultConfig();
    config.defaultAgent = "desktop";
    config.agents = { desktop: binding };
    try {
      await store.upsertRuntimeSession({
        chatId: "client-catalog",
        sessionId: "connect-session",
        agentId: "desktop",
        runtimeSessionId: taskId,
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("client-catalog", "desktop");
      if (!session) throw new Error("fixture Session was not created");
      const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
      await projection.appendUserMessage({
        sessionRef: session.sessionRef,
        text: "What was remembered?",
        origin: "client",
        author: "You",
        id: "turn_connect-turn_user",
      });

      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "workbuddy:user:native-user",
        position: "1.1",
        parentId: null,
        kind: "user",
        text: "What was remembered?",
        state: "complete",
        source: "live",
        data: { clientMessageId: "turn_connect-turn_user" },
      });
      const assistant = {
        id: "workbuddy:assistant:native-assistant",
        position: "1.2",
        parentId: null,
        kind: "assistant" as const,
        text: "cobalt",
        state: "streaming" as const,
        source: "live" as const,
      };
      await projection.upsertRuntimeActivity(session.sessionRef, assistant);
      await projection.upsertRuntimeActivity(session.sessionRef, { ...assistant, text: "cobalt.", state: "complete" });
      await projection.upsertRuntimeActivity(session.sessionRef, { ...assistant, text: "cobalt.", state: "complete" });

      const blocks = await store.listTranscriptBlocks(session.sessionRef);
      expect(blocks).toHaveLength(2);
      expect(blocks.map((block) => block.plainText)).toEqual(["What was remembered?", "cobalt."]);
      expect(blocks[0]).toMatchObject({ origin: "client", runtimeSource: "live" });
      expect(blocks[1]).toMatchObject({ state: "complete", runtimeSource: "live" });
    } finally {
      await registry.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adopts a discovered Task by persisting only its stable Runtime Thread identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbuddy-adapter-adoption-"));
    const taskWorkspace = join(directory, "workspace");
    await mkdir(taskWorkspace);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const runtimeSource: WorkBuddyRuntimeSource = {
      listTasks: async () => [
        { id: taskId, title: "Adopted desktop task", workspace: taskWorkspace, updatedAt: 1_786_000_000_000 },
      ],
      attachTask: async () => history,
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const registry = new RuntimeAdapterRegistry([{ kind: "workbuddy", create: () => adapter }]);
    const config = defaultConfig();
    config.defaultAgent = "arbitrary-binding-id";
    config.agents = { "arbitrary-binding-id": binding };
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
    });
    try {
      const entry = (await catalog.view()).bindings[0]?.entries[0];
      const adopted = await catalog.adopt(entry?.sessionRef ?? "");

      expect(adopted?.runtimeSessionId).toBe(taskId);
      expect(JSON.stringify({ config, adopted })).not.toMatch(/43129|connection-secret|session-secret/u);
    } finally {
      await registry.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects adoption before persisting a Task whose Attachment replay cannot be verified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbuddy-adapter-rejected-adoption-"));
    const taskWorkspace = join(directory, "workspace");
    await mkdir(taskWorkspace);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const runtimeSource: WorkBuddyRuntimeSource = {
      listTasks: async () => [
        { id: taskId, title: "Unverified desktop task", workspace: taskWorkspace, updatedAt: 1_786_000_000_000 },
      ],
      attachTask: async () => {
        throw new Error("WorkBuddy Task replay was incomplete");
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const registry = new RuntimeAdapterRegistry([{ kind: "workbuddy", create: () => adapter }]);
    const config = defaultConfig();
    config.defaultAgent = "desktop";
    config.agents = { desktop: binding };
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
    });
    try {
      const entry = (await catalog.view()).bindings[0]?.entries[0];

      await expect(catalog.adopt(entry?.sessionRef ?? "")).rejects.toThrow("replay was incomplete");
      await expect(store.getRuntimeSessionByRef(entry?.sessionRef ?? "")).resolves.toBeNull();
    } finally {
      await registry.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "application-stopped",
    "endpoint-unavailable",
    "authentication-failed",
    "task-identity-mismatch",
  ] satisfies WorkBuddyDiscoveryFailureCode[])(
    "preserves the stable Task mapping when recovery reports %s",
    async (failureCode) => {
      const directory = await mkdtemp(join(tmpdir(), "workbuddy-adapter-unavailable-"));
      const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
      await store.upsertRuntimeSession({
        chatId: "client",
        sessionId: "connect-session",
        agentId: "desktop",
        runtimeSessionId: taskId,
        hasMessages: true,
        isCurrent: true,
      });
      const mapped = await store.getCurrentRuntimeSession("client", "desktop");
      if (!mapped) throw new Error("fixture Session was not created");
      const runtimeSource: WorkBuddyRuntimeSource = {
        ...source(),
        startTask: async () => {
          throw new WorkBuddyDiscoveryError(failureCode, `unavailable: ${failureCode}`);
        },
      };
      const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
      try {
        await expect(
          adapter.start(binding, {
            agentId: "desktop",
            chatId: "client",
            sessionId: "connect-session",
            runtimeSessionId: taskId,
            configPath: "/private/tmp/connect.json",
            stateDbPath: "/private/tmp/connect.sqlite",
            onRuntimeSessionId: async () => undefined,
          }),
        ).rejects.toMatchObject({ code: failureCode });
        await expect(store.getRuntimeSessionByRef(mapped.sessionRef)).resolves.toMatchObject({
          runtimeSessionId: taskId,
        });
      } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("starts only an adopted Task Attachment and preserves its current model without an explicit override", async () => {
    const prompts: ConnectRuntimePrompt[] = [];
    let attachmentCloses = 0;
    const runtimeSource: WorkBuddyRuntimeSource = {
      ...source(),
      startTask: async (input) => {
        expect(input).toEqual({ profile: "workbuddy-ai", taskId, workspace });
        return {
          verification: verifiedHistory(),
          async *prompt(prompt: ConnectRuntimePrompt): AsyncIterable<RuntimeActivity> {
            prompts.push(prompt);
            yield {
              id: "workbuddy:assistant:native-turn",
              position: "1.2",
              parentId: null,
              kind: "assistant",
              text: "answer from adopted context",
              state: "complete",
              source: "live",
            };
          },
          close: async () => {
            attachmentCloses += 1;
          },
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const baseContext: ConnectRuntimeStartContext = {
      agentId: "desktop",
      chatId: "client",
      sessionId: "connect-session",
      runtimeSessionId: null,
      configPath: "/private/tmp/connect.json",
      stateDbPath: "/private/tmp/connect.sqlite",
      onRuntimeSessionId: async () => undefined,
    };

    await expect(adapter.start(binding, baseContext)).rejects.toThrow(
      "adopt an existing WorkBuddy Task before submitting a turn",
    );

    const session = await adapter.start(binding, { ...baseContext, runtimeSessionId: taskId });
    const activities: RuntimeActivity[] = [];
    for await (const activity of session.prompt({
      prompt: "What did the desktop transcript say?",
      workspace: {
        projectId: null,
        workingDirectory: workspace,
        additionalDirectories: [],
        skipGitRepoCheck: false,
      },
    })) {
      activities.push(activity);
    }

    expect(activities.map((activity) => activity.text)).toEqual(["answer from adopted context"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toHaveProperty("model");
    await session.close();
    await session.close();
    expect(attachmentCloses).toBe(1);
  });

  it("recovers the same Task when its process, port, and credentials rotate before acceptance", async () => {
    const attachmentInputs: Array<{ profile: string; taskId: string; workspace: string }> = [];
    const attachmentRotations = [
      {
        process: { pid: 101, parentPid: 10, executablePath: "/Applications/WorkBuddy AI.app/old-endpoint" },
        endpoint: "http://127.0.0.1:41001/acp",
        credential: "expired-attachment-credential",
      },
      {
        process: { pid: 202, parentPid: 20, executablePath: "/Applications/WorkBuddy AI.app/new-endpoint" },
        endpoint: "http://127.0.0.1:42002/acp",
        credential: "reacquired-attachment-credential",
      },
    ] as const;
    let accepted = 0;
    const runtimeSource: WorkBuddyRuntimeSource = {
      ...source(),
      startTask: async (input) => {
        attachmentInputs.push(input);
        const generation = attachmentInputs.length;
        const ephemeral = attachmentRotations[generation - 1];
        if (!ephemeral) throw new Error("unexpected Attachment generation");
        return {
          verification: {
            ...verifiedHistory(
              generation === 1
                ? history.activities
                : [
                    ...history.activities,
                    {
                      id: "workbuddy:user:desktop-between-connections",
                      position: "1.1",
                      parentId: null,
                      kind: "user",
                      text: "native turn between connections",
                      state: "complete",
                      source: "history",
                    },
                    {
                      id: "workbuddy:assistant:desktop-between-connections",
                      position: "1.2",
                      parentId: null,
                      kind: "assistant",
                      text: "native result between connections",
                      state: "complete",
                      source: "history",
                    },
                  ],
            ),
            connectionOwner: ephemeral.process,
          },
          async *prompt(prompt): AsyncIterable<RuntimeActivity> {
            if (ephemeral.credential.startsWith("expired") && ephemeral.endpoint.includes(":41001")) {
              throw new WorkBuddyDiscoveryError(
                "authentication-failed",
                "rotated credential was rejected before native acceptance",
              );
            }
            await prompt.onAccepted?.();
            yield {
              id: "workbuddy:assistant:recovered-turn",
              position: "1.2",
              parentId: null,
              kind: "assistant",
              text: "continued through rotated credentials",
              state: "complete",
              source: "live",
            };
          },
          close: async () => undefined,
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const session = await adapter.start(binding, {
      agentId: "desktop",
      chatId: "client",
      sessionId: "connect-session",
      runtimeSessionId: taskId,
      configPath: "/private/tmp/connect.json",
      stateDbPath: "/private/tmp/connect.sqlite",
      onRuntimeSessionId: async () => undefined,
    });
    const prompt: ConnectRuntimePrompt = {
      prompt: "continue the adopted task",
      turnId: "recovery-turn",
      onAccepted: async () => {
        accepted += 1;
      },
      workspace: {
        projectId: null,
        workingDirectory: workspace,
        additionalDirectories: [],
        skipGitRepoCheck: false,
      },
    };

    await expect(collect(session.prompt(prompt))).rejects.toMatchObject({ code: "authentication-failed" });
    expect(accepted).toBe(0);
    const recovered = await collect(session.prompt(prompt));
    expect(recovered.map((activity) => activity.id)).toEqual([
      "workbuddy:user:desktop-between-connections",
      "workbuddy:assistant:desktop-between-connections",
      "workbuddy:assistant:recovered-turn",
    ]);
    expect(recovered[1]?.data).toMatchObject({ deliveryDisposition: "projection-only" });
    expect(accepted).toBe(1);
    expect(attachmentInputs).toEqual([
      { profile: "workbuddy-ai", taskId, workspace },
      { profile: "workbuddy-ai", taskId, workspace },
    ]);
  });

  it("reconciles an accepted prompt from rotated Task history without resubmitting it", async () => {
    const promptCalls: string[] = [];
    let attachmentGeneration = 0;
    const recoveredHistory = {
      taskId,
      replayFingerprint: "rotated-history",
      replayStarted: true,
      replayCompleted: true,
      connectionOwner: null,
      activities: [
        ...history.activities.map((activity) =>
          activity.id === "workbuddy:reasoning:native-message"
            ? { ...activity, aliases: ["workbuddy:reasoning:recovered-alias"], data: { phase: "complete" } }
            : activity,
        ),
        {
          id: "workbuddy:user:desktop-during-disconnect",
          position: "1.1",
          parentId: null,
          kind: "user" as const,
          text: "desktop turn while Connect was offline",
          state: "complete" as const,
          source: "history" as const,
        },
        {
          id: "workbuddy:assistant:desktop-during-disconnect",
          position: "1.2",
          parentId: null,
          kind: "assistant" as const,
          text: "desktop-only result",
          state: "complete" as const,
          source: "history" as const,
        },
        {
          id: "workbuddy:user:clawchat-connect-clawchat-uncertain-turn",
          position: "2.1",
          parentId: null,
          kind: "user" as const,
          text: "perform the uncertain operation",
          state: "complete" as const,
          source: "history" as const,
        },
        {
          id: "workbuddy:assistant:uncertain-result",
          position: "2.2",
          parentId: null,
          kind: "assistant" as const,
          text: "the uncertain operation completed once",
          state: "complete" as const,
          source: "history" as const,
        },
      ],
    };
    const runtimeSource: WorkBuddyRuntimeSource = {
      ...source(),
      startTask: async () => {
        attachmentGeneration += 1;
        const generation = attachmentGeneration;
        return {
          verification: generation === 1 ? { ...recoveredHistory, activities: history.activities } : recoveredHistory,
          async *prompt(prompt): AsyncIterable<RuntimeActivity> {
            promptCalls.push(`${generation}:${prompt.prompt}`);
            if (generation === 1) {
              await prompt.onAccepted?.();
              yield {
                id: "workbuddy:assistant:uncertain-result",
                position: "2.2",
                parentId: null,
                kind: "assistant",
                text: "the uncertain operation",
                state: "streaming",
                source: "live",
              };
              throw new Error("transport closed after possible native acceptance");
            }
            yield* [];
          },
          close: async () => undefined,
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const session = await adapter.start(binding, {
      agentId: "desktop",
      chatId: "clawchat",
      sessionId: "connect-session",
      runtimeSessionId: taskId,
      configPath: "/private/tmp/connect.json",
      stateDbPath: "/private/tmp/connect.sqlite",
      onRuntimeSessionId: async () => undefined,
    });

    const activities = await collect(
      session.prompt({
        prompt: "perform the uncertain operation",
        turnId: "uncertain-turn",
        turnOrigin: "clawchat",
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );

    expect(promptCalls).toEqual(["1:perform the uncertain operation"]);
    expect(attachmentGeneration).toBe(2);
    expect(activities.map((activity) => activity.id)).toEqual([
      "workbuddy:assistant:uncertain-result",
      "workbuddy:reasoning:native-message",
      "workbuddy:user:desktop-during-disconnect",
      "workbuddy:assistant:desktop-during-disconnect",
      "workbuddy:user:clawchat-connect-clawchat-uncertain-turn",
      "workbuddy:assistant:uncertain-result",
    ]);
    expect(activities.find((activity) => activity.id === "workbuddy:reasoning:native-message")).toMatchObject({
      aliases: ["workbuddy:reasoning:recovered-alias"],
      data: { phase: "complete", deliveryDisposition: "projection-only" },
    });
    expect(
      activities.find((activity) => activity.id === "workbuddy:assistant:desktop-during-disconnect")?.data,
    ).toMatchObject({
      deliveryDisposition: "projection-only",
    });
    expect(
      activities.find((activity) => activity.id === "workbuddy:user:clawchat-connect-clawchat-uncertain-turn"),
    ).toMatchObject({
      aliases: ["workbuddy:user:connect:uncertain-turn"],
      data: { clawchatMessageId: "uncertain-turn" },
    });
    expect(activities.findLast((activity) => activity.id === "workbuddy:assistant:uncertain-result")).toMatchObject({
      text: "the uncertain operation completed once",
      state: "complete",
    });
  });

  it("reconciles transmission loss even when native acceptance was never observed", async () => {
    let attachmentGeneration = 0;
    let accepted = 0;
    const submittedId = "workbuddy:user:clawchat-connect-client-unobserved-acceptance";
    const runtimeSource: WorkBuddyRuntimeSource = {
      ...source(),
      startTask: async () => {
        attachmentGeneration += 1;
        const generation = attachmentGeneration;
        return {
          verification: {
            taskId,
            replayFingerprint: `generation-${generation}`,
            replayStarted: true,
            replayCompleted: true,
            connectionOwner: null,
            activities:
              generation === 1
                ? history.activities
                : [
                    ...history.activities,
                    {
                      id: submittedId,
                      position: "1.1",
                      parentId: null,
                      kind: "user",
                      text: "possibly accepted",
                      state: "complete",
                      source: "history",
                    },
                    {
                      id: "workbuddy:assistant:unobserved-result",
                      position: "1.2",
                      parentId: null,
                      kind: "assistant",
                      text: "committed before the socket closed",
                      state: "complete",
                      source: "history",
                    },
                  ],
          },
          async *prompt(): AsyncIterable<RuntimeActivity> {
            if (generation === 1) throw new WorkBuddyPromptTransportError();
            yield* [];
          },
          close: async () => undefined,
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const session = await adapter.start(binding, {
      agentId: "desktop",
      chatId: "client",
      sessionId: "connect-session",
      runtimeSessionId: taskId,
      configPath: "/private/tmp/connect.json",
      stateDbPath: "/private/tmp/connect.sqlite",
      onRuntimeSessionId: async () => undefined,
    });

    await expect(
      collect(
        session.prompt({
          prompt: "possibly accepted",
          turnId: "unobserved-acceptance",
          onAccepted: async () => {
            accepted += 1;
          },
          workspace: {
            projectId: null,
            workingDirectory: workspace,
            additionalDirectories: [],
            skipGitRepoCheck: false,
          },
        }),
      ),
    ).resolves.toMatchObject([{ id: submittedId }, { id: "workbuddy:assistant:unobserved-result" }]);
    expect(accepted).toBe(0);
    expect(attachmentGeneration).toBe(2);
  });

  it("expires lost-Attachment interactions and routes later cancellation only to the recovered Attachment", async () => {
    let attachmentGeneration = 0;
    let lostInteractionSignal: AbortSignal | undefined;
    let lostInteractionExpired = false;
    const cancelCalls: number[] = [];
    const runtimeSource: WorkBuddyRuntimeSource = {
      ...source(),
      startTask: async () => {
        attachmentGeneration += 1;
        const generation = attachmentGeneration;
        return {
          verification: verifiedHistory(),
          async *prompt(input): AsyncIterable<RuntimeActivity> {
            if (generation !== 1) return;
            await input.onAccepted?.();
            void input.interactionPort
              ?.request(
                {
                  kind: "approval",
                  action: "command",
                  title: "Old Attachment approval",
                  description: "Must expire on connection loss",
                  options: [{ id: "approve-once", label: "Approve" }],
                },
                {
                  sessionRef: "session-ref",
                  turnId: "interaction-turn",
                  origin: "client",
                  deliveryConfirmation: Promise.resolve(),
                },
              )
              .catch(() => {
                lostInteractionExpired = true;
              });
            throw new WorkBuddyPromptTransportError();
          },
          cancel: async () => {
            cancelCalls.push(generation);
            return true;
          },
          close: async () => undefined,
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const session = await adapter.start(binding, {
      agentId: "desktop",
      chatId: "client",
      sessionId: "connect-session",
      runtimeSessionId: taskId,
      configPath: "/private/tmp/connect.json",
      stateDbPath: "/private/tmp/connect.sqlite",
      onRuntimeSessionId: async () => undefined,
    });

    await expect(
      collect(
        session.prompt({
          prompt: "request approval before rotation",
          turnId: "interaction-turn",
          interactionPort: {
            request: async (_request, context) => {
              lostInteractionSignal = context.signal;
              await new Promise<void>((_resolve, reject) => {
                context.signal?.addEventListener("abort", () => reject(new Error("interaction expired")), {
                  once: true,
                });
              });
              throw new Error("unreachable");
            },
          },
          workspace: {
            projectId: null,
            workingDirectory: workspace,
            additionalDirectories: [],
            skipGitRepoCheck: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "prompt-not-committed" });
    await Promise.resolve();

    expect(lostInteractionSignal?.aborted).toBeTrue();
    expect(lostInteractionExpired).toBeTrue();
    await expect(session.cancel?.()).resolves.toBeTrue();
    expect(cancelCalls).toEqual([2]);
  });

  it.each([
    ["prompt-not-committed", []],
    [
      "prompt-failed",
      [
        {
          id: "workbuddy:user:clawchat-connect-client-unsettled-turn",
          position: "1.1",
          parentId: null,
          kind: "user" as const,
          text: "unsettled prompt",
          state: "complete" as const,
          source: "history" as const,
        },
        {
          id: "workbuddy:assistant:failed-turn",
          position: "1.2",
          parentId: null,
          kind: "assistant" as const,
          text: "native prompt failed",
          state: "error" as const,
          source: "history" as const,
        },
      ],
    ],
    [
      "prompt-outcome-indeterminate",
      [
        {
          id: "workbuddy:user:clawchat-connect-client-unsettled-turn",
          position: "1.1",
          parentId: null,
          kind: "user" as const,
          text: "unsettled prompt",
          state: "complete" as const,
          source: "history" as const,
        },
      ],
    ],
  ] as const)("surfaces %s without retrying an uncertain prompt", async (expectedCode, recoveredTurn) => {
    let attachmentGeneration = 0;
    let promptCalls = 0;
    const runtimeSource: WorkBuddyRuntimeSource = {
      ...source(),
      startTask: async () => {
        attachmentGeneration += 1;
        const generation = attachmentGeneration;
        return {
          verification: verifiedHistory(
            generation === 1 ? history.activities : [...history.activities, ...recoveredTurn],
          ),
          async *prompt(input): AsyncIterable<RuntimeActivity> {
            promptCalls += 1;
            await input.onAccepted?.();
            yield* [];
            throw new WorkBuddyPromptTransportError();
          },
          close: async () => undefined,
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const session = await adapter.start(binding, {
      agentId: "desktop",
      chatId: "client",
      sessionId: "connect-session",
      runtimeSessionId: taskId,
      configPath: "/private/tmp/connect.json",
      stateDbPath: "/private/tmp/connect.sqlite",
      onRuntimeSessionId: async () => undefined,
    });

    await expect(
      collect(
        session.prompt({
          prompt: "unsettled prompt",
          turnId: "unsettled-turn",
          workspace: {
            projectId: null,
            workingDirectory: workspace,
            additionalDirectories: [],
            skipGitRepoCheck: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: expectedCode });
    expect(promptCalls).toBe(1);
    expect(attachmentGeneration).toBe(2);
  });
});

async function collect(activities: AsyncIterable<RuntimeActivity>): Promise<RuntimeActivity[]> {
  const result: RuntimeActivity[] = [];
  for await (const activity of activities) result.push(activity);
  return result;
}

function verifiedHistory(activities: RuntimeActivity[] = history.activities) {
  return {
    taskId,
    replayFingerprint: "verified-history",
    replayStarted: true,
    replayCompleted: true,
    activities,
    connectionOwner: null,
  };
}
