import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/client-interface/session-catalog";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimePrompt, ConnectRuntimeStartContext, RuntimeActivity } from "../src/runtime/types";
import { createWorkBuddyRuntimeAdapter, type WorkBuddyRuntimeSource } from "../src/runtime/workbuddy-adapter";
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

  it("starts only an adopted Task Attachment and preserves its current model without an explicit override", async () => {
    const prompts: ConnectRuntimePrompt[] = [];
    let attachmentCloses = 0;
    const runtimeSource: WorkBuddyRuntimeSource = {
      ...source(),
      startTask: async (input) => {
        expect(input).toEqual({ profile: "workbuddy-ai", taskId, workspace });
        return {
          async *prompt(prompt): AsyncIterable<RuntimeActivity> {
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
});
