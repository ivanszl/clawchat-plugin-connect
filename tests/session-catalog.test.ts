import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionCatalog } from "../src/client-interface/session-catalog";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";
import { type ConnectStateStore, createStateStore } from "../src/state";

const stores: ConnectStateStore[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(async (store) => await store.close()));
});

describe("Session Catalog workspace grouping", () => {
  it("does not expose a child Runtime Thread as a standalone Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-child-thread-"));
    const workspace = join(directory, "project");
    await mkdir(workspace);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => [
        { runtimeThreadId: "thread-parent", name: "Parent task", updatedAt: 2, workingDirectory: workspace },
        {
          runtimeThreadId: "thread-child",
          parentRuntimeThreadId: "thread-parent",
          name: "Child task",
          updatedAt: 1,
          workingDirectory: workspace,
        },
      ],
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];

    expect(entries.map((entry) => entry.name)).toEqual(["Parent task"]);
  });

  it("groups discovered Runtime Threads by their native working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-"));
    const firstWorkspace = join(directory, "first-project");
    const secondWorkspace = join(directory, "second-project");
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => [
        {
          runtimeThreadId: "thread-first",
          name: "First task",
          updatedAt: 2,
          workingDirectory: firstWorkspace,
        },
        {
          runtimeThreadId: "thread-second",
          name: "Second task",
          updatedAt: 1,
          workingDirectory: secondWorkspace,
        },
      ],
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.workspaceName)).toEqual([basename(firstWorkspace), basename(secondWorkspace)]);
    expect(entries[0]?.workspaceId).toBeTruthy();
    expect(entries[1]?.workspaceId).toBeTruthy();
    expect(entries[0]?.workspaceId).not.toBe(entries[1]?.workspaceId);
    await expect(catalog.sessionView(entries[0]?.sessionRef ?? "")).resolves.toMatchObject({
      workspaceName: basename(firstWorkspace),
    });

    const adopted = await catalog.adopt(entries[0]?.sessionRef ?? "");
    const adoptedProject = adopted?.projectId ? await store.getProject(adopted.projectId) : null;
    expect(adoptedProject?.rootPath).toBe(await realpath(firstWorkspace));
  });

  it("keeps Codex App scratch threads as direct Non-Project leaves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-date-workspaces-"));
    const firstWorkspace = join(directory, "2026-07-24", "f");
    const secondWorkspace = join(directory, "2026-07-23", "f");
    await Promise.all([mkdir(firstWorkspace, { recursive: true }), mkdir(secondWorkspace, { recursive: true })]);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => [
        {
          runtimeThreadId: "thread-current-date",
          name: "Current date task",
          updatedAt: 2,
          workingDirectory: firstWorkspace,
          workspaceKind: "transient",
        },
        {
          runtimeThreadId: "thread-previous-date",
          name: "Previous date task",
          updatedAt: 1,
          workingDirectory: secondWorkspace,
          workspaceKind: "transient",
        },
      ],
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.workspaceId)).toEqual([null, null]);
    expect(entries.map((entry) => entry.workspaceName)).toEqual([null, null]);

    const adopted = await catalog.adopt(entries[0]?.sessionRef ?? "");
    expect(adopted?.projectId).toBeNull();
    expect(await store.listProjects()).toEqual([]);
    expect((await catalog.view()).bindings[0]?.entries[0]).toMatchObject({
      sessionRef: entries[0]?.sessionRef,
      workspaceId: null,
      workspaceName: null,
    });
  });

  it("keeps a managed Non-Project Session as a direct catalog leaf", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-non-project-"));
    const isolatedWorkspace = join(directory, "workspaces", "agent", "chat", "session");
    await mkdir(isolatedWorkspace, { recursive: true });
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      runtimeSessionId: "thread-non-project",
      projectId: null,
      name: "Non-Project task",
      hasMessages: true,
      isCurrent: true,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => [
        {
          runtimeThreadId: "thread-non-project",
          name: "Non-Project task",
          updatedAt: 1,
          workingDirectory: isolatedWorkspace,
        },
      ],
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entry = (await catalog.view()).bindings[0]?.entries[0];

    expect(entry).toMatchObject({ projectId: null, workspaceId: null, workspaceName: null });
  });

  it("shows activity only on the Session whose turn is active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-activity-"));
    const refs = ["ABCDEFGH", "JKLMNPQR"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => refs.shift() ?? "STUVWXYZ",
    });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-active",
      sessionId: "session-active",
      agentId: "codex",
      runtimeSessionId: "thread-active",
      name: "Active task",
      hasMessages: true,
      isCurrent: true,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-idle",
      sessionId: "session-idle",
      agentId: "codex",
      runtimeSessionId: "thread-idle",
      name: "Idle task",
      hasMessages: true,
      isCurrent: true,
    });
    await store.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: "codex",
      activeChats: 1,
      globalRunning: 1,
      globalQueued: 0,
      recentError: null,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => [],
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
      sessionActivity: (_bindingId, sessionRef) => (sessionRef === "ABCDEFGH" ? "running" : "idle"),
      activeTurnId: (_bindingId, sessionRef) => (sessionRef === "ABCDEFGH" ? "turn-active" : null),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];

    expect(entries.find((entry) => entry.sessionRef === "ABCDEFGH")?.status).toBe("running");
    expect(entries.find((entry) => entry.sessionRef === "JKLMNPQR")?.status).toBe("idle");
    expect(entries.find((entry) => entry.sessionRef === "ABCDEFGH")?.allowedActions).not.toContain("archive");
    expect(entries.find((entry) => entry.sessionRef === "ABCDEFGH")?.allowedActions).not.toContain("delete");
    await expect(catalog.sessionView("ABCDEFGH")).resolves.toMatchObject({ activeTurnId: "turn-active" });
  });

  it("derives lifecycle actions from Runtime Adapter capabilities and Runtime Thread availability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-capabilities-"));
    const refs = ["ABCDEFGH", "JKLMNPQR"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => refs.shift() ?? "STUVWXYZ",
    });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-empty",
      sessionId: "session-empty",
      agentId: "codex",
      runtimeSessionId: null,
      name: "Empty",
      isCurrent: true,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-thread",
      sessionId: "session-thread",
      agentId: "codex",
      runtimeSessionId: "thread-1",
      name: "Thread",
      hasMessages: true,
      isCurrent: true,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      lifecycleCapabilities: { archive: false, restore: false, delete: false },
      discoverAllThreads: async () => [
        {
          runtimeThreadId: "thread-1",
          name: "Thread",
          updatedAt: 1,
          workingDirectory: directory,
        },
      ],
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];
    expect(entries.find((entry) => entry.name === "Empty")?.allowedActions).toEqual(["open", "send"]);
    expect(entries.find((entry) => entry.name === "Thread")?.allowedActions).toEqual(["open", "send", "cancel"]);
    await expect(catalog.sessionView("ABCDEFGH")).resolves.toMatchObject({ allowedActions: ["send"] });
    await expect(catalog.sessionView("JKLMNPQR")).resolves.toMatchObject({ allowedActions: ["send", "cancel"] });
    await expect(catalog.archive("JKLMNPQR")).rejects.toMatchObject({ code: "session-action-unsupported" });
  });

  it("archives, restores, and permanently deletes a native Runtime Thread by Session Ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-lifecycle-"));
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => "ABCDEFGH",
    });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      runtimeSessionId: "thread-1",
      name: "Lifecycle task",
      mode: "workspace-write",
      hasMessages: true,
      isCurrent: true,
    });
    const session = await store.getCurrentRuntimeSession("chat-1", "codex");
    if (!session) throw new Error("test session was not created");
    await store.upsertTranscriptBlock(session.sessionRef, {
      id: "message-1",
      type: "message",
      origin: "runtime",
      state: "complete",
      plainText: "history",
      role: "assistant",
      author: "Codex",
      markdown: "history",
    });
    let archived = false;
    let deleted = false;
    const calls: string[] = [];
    const summary = {
      runtimeThreadId: "thread-1",
      name: "Lifecycle task",
      updatedAt: 1,
      workingDirectory: directory,
    };
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => (!archived && !deleted ? [summary] : []),
      discoverArchivedThreads: async () => (archived && !deleted ? [{ ...summary, isArchived: true }] : []),
      archiveThread: async (_binding, threadId) => {
        calls.push(`archive:${threadId}`);
        archived = true;
      },
      unarchiveThread: async (_binding, threadId) => {
        calls.push(`unarchive:${threadId}`);
        archived = false;
      },
      deleteThread: async (_binding, threadId) => {
        calls.push(`delete:${threadId}`);
        deleted = true;
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    await expect(catalog.archive(session.sessionRef)).resolves.toBe(true);
    await expect(catalog.sessionView(session.sessionRef)).resolves.toMatchObject({
      isArchived: true,
      allowedActions: ["unarchive", "delete"],
    });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      name: "Lifecycle task",
      mode: "workspace-write",
    });

    await expect(catalog.unarchive(session.sessionRef)).resolves.toBe(true);
    await expect(catalog.sessionView(session.sessionRef)).resolves.toMatchObject({ isArchived: false });

    await expect(catalog.delete(session.sessionRef)).resolves.toBe(true);
    expect(calls).toEqual(["archive:thread-1", "unarchive:thread-1", "delete:thread-1"]);
    await expect(store.getSessionRefTarget(session.sessionRef)).resolves.toBeNull();
    await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toEqual([]);
    await expect(catalog.sessionView(session.sessionRef)).resolves.toBeNull();
  });
});
