import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionCatalog } from "../src/client-interface/session-catalog";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { type ConnectStateStore, createStateStore } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { type ConnectRuntimeAdapter, completeRuntimeThreadDiscovery } from "../src/runtime/types";
import { encodeCodeBuddySessionId } from "../src/runtime/workbuddy-runtime-target";
import { WorkBuddyDiscoveryError } from "../src/runtime/workbuddy-task-discovery";
import { fixedRuntimeAdapter, pluginBinding } from "./runtime-adapter-fixture";

const stores: ConnectStateStore[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(async (store) => await store.close()));
});
const persistentWorkspace = (rootPath: string) => ({
  key: rootPath,
  kind: "persistent" as const,
  localRoot: rootPath,
});

describe("Session Catalog workspace grouping", () => {
  it("keeps startup-unavailable WorkBuddy Sessions openable without advertising turn submission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-unavailable-"));
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => "ABCDEFGH",
    });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "desktop",
      runtimeSessionId: "task-unavailable",
      workspaceRef: null,
      name: "Unavailable WorkBuddy Task",
      hasMessages: true,
      isCurrent: true,
    });
    await store.setRuntimeAvailability("desktop", "startup-unavailable", "WorkBuddy is not running");
    let discoveryCalls = 0;
    const adapter: ConnectRuntimeAdapter = {
      kind: "workbuddy",
      modes: [],
      discoverAllThreads: async () => {
        discoveryCalls += 1;
        throw new Error("must not probe unavailable WorkBuddy");
      },
      discoverArchivedThreads: async () => {
        discoveryCalls += 1;
        throw new Error("must not probe unavailable WorkBuddy");
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { desktop: pluginBinding({ profile: "workbuddy-cn" }, { displayName: "WorkBuddy" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    await expect(catalog.view()).resolves.toMatchObject({
      bindings: [
        {
          bindingId: "desktop",
          status: "disconnected",
          entries: [
            {
              sessionRef: "ABCDEFGH",
              name: "Unavailable WorkBuddy Task",
              status: "offline",
              allowedActions: ["open"],
            },
          ],
        },
      ],
    });
    await expect(catalog.sessionView("ABCDEFGH")).resolves.toMatchObject({
      sessionRef: "ABCDEFGH",
      name: "Unavailable WorkBuddy Task",
      status: "offline",
      runtimeThreadAvailable: false,
      allowedActions: [],
      turnSubmissionCapability: {
        prompt: { allowed: false },
        attachments: {
          allowedKinds: [],
          allowedMediaTypes: [],
          maxCount: 0,
        },
      },
    });
    expect(discoveryCalls).toBe(0);
  });

  it("isolates a failed WorkBuddy discovery from a healthy Binding and keeps durable Sessions openable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-binding-isolation-"));
    const refs = ["ABCDEFGH", "JKLMNPQR"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => refs.shift() ?? "STUVWXYZ",
    });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-offline",
      sessionId: "session-offline",
      agentId: "workbuddy-offline",
      runtimeSessionId: "task-offline",
      workspaceRef: null,
      name: "Durable Offline Task",
      hasMessages: true,
      isCurrent: true,
    });
    await store.setRuntimeConnectionStatus("workbuddy-offline", false, "WorkBuddy is temporarily unavailable");
    await store.setRuntimeConnectionStatus("workbuddy-healthy", true, null);
    const adapter: ConnectRuntimeAdapter = {
      kind: "workbuddy",
      modes: [],
      discoverAllThreads: async (binding) => {
        if (binding.runtimeConfig.profile === "offline") {
          throw new WorkBuddyDiscoveryError(
            "application-stopped",
            "WorkBuddy discovery endpoint is temporarily unavailable",
          );
        }
        return completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "task-healthy",
            name: "Healthy WorkBuddy Task",
            updatedAt: 2,
            workspaceIdentity: persistentWorkspace(directory),
          },
        ]);
      },
      discoverArchivedThreads: async () => completeRuntimeThreadDiscovery([], { reason: "archived" }),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = {
      "workbuddy-offline": pluginBinding({ profile: "offline" }, { displayName: "Offline WorkBuddy" }),
      "workbuddy-healthy": pluginBinding({ profile: "healthy" }, { displayName: "Healthy WorkBuddy" }),
    };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const view = await catalog.view();
    expect(view.bindings.find((binding) => binding.bindingId === "workbuddy-healthy")).toMatchObject({
      status: "connected",
      entries: [{ name: "Healthy WorkBuddy Task", status: "idle" }],
    });
    expect(view.bindings.find((binding) => binding.bindingId === "workbuddy-offline")).toMatchObject({
      status: "disconnected",
      entries: [
        {
          sessionRef: "ABCDEFGH",
          name: "Durable Offline Task",
          status: "offline",
          allowedActions: ["open"],
        },
      ],
    });
    await expect(catalog.sessionView("ABCDEFGH")).resolves.toMatchObject({
      name: "Durable Offline Task",
      status: "offline",
      runtimeThreadAvailable: false,
      allowedActions: [],
      turnSubmissionCapability: {
        prompt: { allowed: false },
        attachments: { allowedKinds: [], maxCount: 0 },
      },
    });
  });

  it("keeps active WorkBuddy Tasks online when only archived discovery is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-archived-unavailable-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    await store.setRuntimeConnectionStatus("workbuddy", true, null);
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "workbuddy",
        modes: [],
        discoverAllThreads: async () =>
          completeRuntimeThreadDiscovery([
            {
              runtimeThreadId: "task-active",
              name: "Active WorkBuddy Task",
              updatedAt: 2,
              workspaceIdentity: persistentWorkspace(directory),
            },
          ]),
        discoverArchivedThreads: async () => {
          throw new WorkBuddyDiscoveryError("endpoint-unavailable", "Archived Task discovery is unavailable");
        },
        start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      }),
    ]);
    const config = defaultConfig();
    config.agents = { workbuddy: pluginBinding({}, { displayName: "WorkBuddy" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    await expect(catalog.view()).resolves.toMatchObject({
      bindings: [
        {
          bindingId: "workbuddy",
          status: "connected",
          entries: [{ name: "Active WorkBuddy Task", status: "idle", allowedActions: ["open", "adopt"] }],
        },
      ],
    });
  });

  it("propagates non-WorkBuddy discovery failures instead of masking provider defects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-provider-failure-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    await store.setRuntimeConnectionStatus("codex", true, null);
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: [],
        discoverAllThreads: async () => {
          throw new Error("Codex discovery invariant failed");
        },
        start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      }),
    ]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    await expect(catalog.view()).rejects.toThrow("Codex discovery invariant failed");
  });

  it("keeps Sessions inspectable and offline when their installed Runtime Plugin is inactive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-plugin-inactive-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "plugin-binding",
      runtimeSessionId: "thread-1",
      workspaceRef: null,
      name: "Archived Plugin Session",
      hasMessages: true,
      isCurrent: true,
    });
    const config = defaultConfig();
    config.agents = { "plugin-binding": pluginBinding({}, { displayName: "Plugin Binding" }) };
    const runtimeAdapters = new RuntimeAdapterRegistry([]);
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      runtimeFamily: () => "fixture",
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const catalogView = await catalog.view();
    const entry = catalogView.bindings[0]?.entries[0];
    expect(catalogView.bindings[0]).toMatchObject({
      bindingId: "plugin-binding",
      kind: "fixture",
      status: "disconnected",
    });
    expect(entry).toMatchObject({
      name: "Archived Plugin Session",
      status: "offline",
      allowedActions: ["open"],
    });
    await expect(catalog.sessionView(entry?.sessionRef ?? "")).resolves.toMatchObject({
      status: "offline",
      allowedActions: [],
      turnSubmissionCapability: { prompt: { allowed: false } },
    });
  });

  it("does not treat a transient ClawChat connection error as Runtime startup unavailability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-transient-transport-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    await store.setRuntimeConnectionStatus("codex", false, "ClawChat transport reconnecting");
    let discoveryCalls = 0;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => {
        discoveryCalls += 1;
        return completeRuntimeThreadDiscovery([]);
      },
      discoverArchivedThreads: async () => {
        discoveryCalls += 1;
        return completeRuntimeThreadDiscovery([], { reason: "archived" });
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };

    await new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    }).view();

    expect(discoveryCalls).toBe(3);
  });

  it("returns remembered Runtime Workspace locations without refreshing Runtime discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-location-cache-"));
    const workspace = join(directory, "project");
    await mkdir(workspace);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    let discoveryCalls = 0;
    let discoveryBlocked = false;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => {
        discoveryCalls += 1;
        if (discoveryBlocked) return await new Promise<never>(() => undefined);
        return completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "thread-project",
            name: "Project task",
            updatedAt: 1,
            workspaceIdentity: persistentWorkspace(workspace),
          },
        ]);
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });
    await catalog.view();
    catalog.invalidate();
    discoveryBlocked = true;

    const locations = await Promise.race([
      catalog.runtimeWorkspaceLocations(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expect(locations).toEqual([{ name: "project", path: await realpath(workspace) }]);
    expect(discoveryCalls).toBe(2);
  });

  it("does not expose a child Runtime Thread as a standalone Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-child-thread-"));
    const workspace = join(directory, "project");
    await mkdir(workspace);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "thread-parent",
            name: "Parent task",
            updatedAt: 2,
            workspaceIdentity: persistentWorkspace(workspace),
          },
          {
            runtimeThreadId: "thread-child",
            parentRuntimeThreadId: "thread-parent",
            name: "Child task",
            updatedAt: 1,
            workspaceIdentity: persistentWorkspace(workspace),
          },
        ]),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];

    expect(entries.map((entry) => entry.name)).toEqual(["Parent task"]);
  });

  it("synchronizes active persistent Runtime Workspaces into binding-scoped Workspaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-"));
    const firstWorkspace = join(directory, "first-project");
    const secondWorkspace = join(directory, "second-project");
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "thread-first",
            name: "First task",
            updatedAt: 2,
            workspaceIdentity: persistentWorkspace(firstWorkspace),
          },
          {
            runtimeThreadId: "thread-second",
            name: "Second task",
            updatedAt: 1,
            workspaceIdentity: persistentWorkspace(secondWorkspace),
          },
        ]),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.workspaceName)).toEqual([basename(firstWorkspace), basename(secondWorkspace)]);
    expect(entries[0]?.workspaceRef).toBeTruthy();
    expect(entries[1]?.workspaceRef).toBeTruthy();
    expect(entries[0]?.workspaceRef).not.toBe(entries[1]?.workspaceRef);
    await expect(store.listWorkspaces("codex")).resolves.toHaveLength(3);
    await expect(catalog.sessionView(entries[0]?.sessionRef ?? "")).resolves.toMatchObject({
      workspaceName: basename(firstWorkspace),
    });

    const adopted = await catalog.adopt(entries[0]?.sessionRef ?? "");
    const adoptedProject = adopted?.workspaceRef ? await store.getWorkspace("codex", adopted.workspaceRef) : null;
    expect(adoptedProject?.rootPath).toBe(await realpath(firstWorkspace));
  });

  it("keeps a discovered Session selectable when its Runtime option catalog is temporarily unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-options-unavailable-"));
    const workspace = join(directory, "project");
    await mkdir(workspace);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    const adapter: ConnectRuntimeAdapter = {
      kind: "workbuddy",
      modes: [],
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "task-native",
            name: "Native Task",
            updatedAt: 2,
            workspaceIdentity: persistentWorkspace(workspace),
          },
        ]),
      listModels: async () => {
        throw new Error("native Task replay is temporarily unavailable");
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { desktop: pluginBinding({ profile: "workbuddy-cn" }, { displayName: "WorkBuddy" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entry = (await catalog.view()).bindings[0]?.entries[0];

    await expect(catalog.sessionView(entry?.sessionRef ?? "")).resolves.toMatchObject({
      name: "Native Task",
      modelOptions: [],
    });
  });

  it("assigns an archived Runtime Thread to Default without synchronizing its archived root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-archived-workspace-"));
    const workspace = join(directory, "archived-project");
    await mkdir(workspace);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => completeRuntimeThreadDiscovery([]),
      discoverArchivedThreads: async () =>
        completeRuntimeThreadDiscovery(
          [
            {
              runtimeThreadId: "thread-archived",
              name: "Archived task",
              updatedAt: 1,
              workspaceIdentity: persistentWorkspace(workspace),
              isArchived: true,
            },
          ],
          { reason: "archived" },
        ),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entry = (await catalog.view()).bindings[0]?.entries[0];

    expect(entry).toMatchObject({ isArchived: true, workspaceRef: expect.any(String), workspaceName: "Default" });
    await expect(store.listWorkspaces()).resolves.toHaveLength(1);
  });

  it("places Codex App scratch threads in the binding Default Workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-date-workspaces-"));
    const firstWorkspace = join(directory, "2026-07-24", "f");
    const secondWorkspace = join(directory, "2026-07-23", "f");
    await Promise.all([mkdir(firstWorkspace, { recursive: true }), mkdir(secondWorkspace, { recursive: true })]);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    await store.reconcileWorkspaceCatalog({
      bindingId: "codex",
      status: "partial",
      identities: [
        {
          runtimeIdentityKey: firstWorkspace,
          rootPath: await realpath(firstWorkspace),
          name: "f",
          workspaceRef: "STALE001",
        },
      ],
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "thread-current-date",
            name: "Current date task",
            updatedAt: 2,
            workspaceIdentity: { key: firstWorkspace, kind: "transient", localRoot: firstWorkspace },
          },
          {
            runtimeThreadId: "thread-previous-date",
            name: "Previous date task",
            updatedAt: 1,
            workspaceIdentity: { key: secondWorkspace, kind: "transient", localRoot: secondWorkspace },
          },
        ]),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.workspaceRef)).toEqual([expect.any(String), expect.any(String)]);
    expect(entries.map((entry) => entry.workspaceName)).toEqual(["Default", "Default"]);

    const adopted = await catalog.adopt(entries[0]?.sessionRef ?? "");
    expect(adopted?.workspaceRef).toEqual(expect.any(String));
    await expect(store.listWorkspaces("codex")).resolves.toHaveLength(2);
    expect((await catalog.view()).bindings[0]?.entries[0]).toMatchObject({
      sessionRef: entries[0]?.sessionRef,
      workspaceRef: expect.any(String),
      workspaceName: "Default",
    });
  });

  it("assigns a legacy Session without a Workspace to the Binding Default", async () => {
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
      workspaceRef: null,
      name: "Legacy task",
      hasMessages: true,
      isCurrent: true,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "thread-non-project",
            name: "Legacy task",
            updatedAt: 1,
            workspaceIdentity: persistentWorkspace(isolatedWorkspace),
          },
        ]),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entry = (await catalog.view()).bindings[0]?.entries[0];

    expect(entry).toMatchObject({ workspaceRef: expect.any(String), workspaceName: "Default" });
  });

  it("keeps a managed CodeBuddy Session sendable when WorkBuddy desktop discovery cannot list it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-codebuddy-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    stores.push(store);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "desktop",
      runtimeSessionId: encodeCodeBuddySessionId("native-codebuddy-session"),
      workspaceRef: null,
      name: "ClawChat CodeBuddy Session",
      hasMessages: true,
      isCurrent: true,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "workbuddy",
      modes: [],
      discoverAllThreads: async () => completeRuntimeThreadDiscovery([]),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { desktop: pluginBinding({ profile: "workbuddy-cn" }, { displayName: "WorkBuddy" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entry = (await catalog.view()).bindings[0]?.entries[0];

    expect(entry).toMatchObject({
      name: "ClawChat CodeBuddy Session",
      allowedActions: ["open", "send", "cancel"],
    });
    await expect(catalog.sessionView(entry?.sessionRef ?? "")).resolves.toMatchObject({
      runtimeThreadAvailable: true,
      allowedActions: ["send", "cancel"],
    });
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
      discoverAllThreads: async () => completeRuntimeThreadDiscovery([]),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
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

  it("keeps immutable mapped Sessions sendable when current native discovery temporarily omits their Thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-session-catalog-capabilities-"));
    const refs = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
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
    await store.upsertRuntimeSession({
      chatId: "chat-temporarily-absent",
      sessionId: "session-temporarily-absent",
      agentId: "codex",
      runtimeSessionId: "thread-temporarily-absent",
      name: "Temporarily absent thread",
      hasMessages: true,
      isCurrent: true,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      lifecycleCapabilities: { archive: false, restore: false, delete: false, recoverMissing: true },
      listModels: async () => [
        {
          id: "test/model",
          selection: { model: "test/model" },
          displayName: "Test",
          description: "Test model",
          isDefault: true,
          defaultReasoningEffort: "default",
          supportedReasoningEfforts: ["default"],
          inputModalities: ["text", "image", "audio"],
          turnSubmissionCapability: {
            prompt: { allowed: true, required: false },
            attachments: {
              allowedKinds: ["image", "file", "audio", "video"],
              allowedMediaTypes: ["*/*"],
            },
          },
        },
      ],
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "thread-1",
            name: "Thread",
            updatedAt: 1,
            workspaceIdentity: persistentWorkspace(directory),
          },
        ]),
      readActivity: async (_binding, runtimeThreadId) => {
        if (runtimeThreadId === "thread-temporarily-absent") {
          throw new Error(`Native Runtime Thread is temporarily unavailable: ${runtimeThreadId}`);
        }
        return { activities: [], completeness: "complete", limitations: [] };
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection: new TranscriptProjection({ config, stateStore: store, runtimeAdapters }),
    });

    const entries = (await catalog.view()).bindings[0]?.entries ?? [];
    expect(entries.find((entry) => entry.name === "Empty")?.allowedActions).toEqual(["open", "send"]);
    expect(entries.find((entry) => entry.name === "Thread")?.allowedActions).toEqual(["open", "send", "cancel"]);
    expect(entries.find((entry) => entry.name === "Temporarily absent thread")?.allowedActions).toEqual([
      "open",
      "send",
    ]);
    await expect(catalog.sessionView("ABCDEFGH")).resolves.toMatchObject({ allowedActions: ["send"] });
    await expect(catalog.sessionView("ABCDEFGH")).resolves.toMatchObject({
      turnSubmissionCapability: {
        attachments: { allowedKinds: ["image", "file", "audio", "video"] },
      },
    });
    await expect(catalog.sessionView("JKLMNPQR")).resolves.toMatchObject({ allowedActions: ["send", "cancel"] });
    await expect(catalog.sessionView("STUVWXYZ")).resolves.toMatchObject({
      runtimeThreadAvailable: false,
      allowedActions: ["send"],
      turnSubmissionCapability: { prompt: { allowed: true } },
    });
    await expect(catalog.ensureProjection("STUVWXYZ", true)).resolves.toBe(true);
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
      workspaceIdentity: persistentWorkspace(directory),
    };
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () => completeRuntimeThreadDiscovery(!archived && !deleted ? [summary] : []),
      discoverArchivedThreads: async () =>
        completeRuntimeThreadDiscovery(archived && !deleted ? [{ ...summary, isArchived: true }] : [], {
          reason: "archived",
        }),
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
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
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
