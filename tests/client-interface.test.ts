import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionCatalogView, SessionView } from "../src/client-contract";
import {
  type ClientHttpServerOptions,
  type ClientInterfaceHandle,
  type ConnectClientApplicationServices,
  type ConnectClientOwnedInterfaceOptions,
  createCoreConnectClientApplicationPort,
  startClientInterface as startOwnedClientInterface,
} from "../src/client-interface/server";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { ConnectConfigMutationCoordinator, defaultConfig, loadConfig } from "../src/config";
import { type ConnectStateStore, createStateStore } from "../src/persistence/state";
import { agentBindingIdentity } from "../src/plugin/binding";
import type { ConnectPluginManagement } from "../src/plugin/host";
import { CONNECT_CLIENT_MANAGED_WEB_APP_REF } from "../src/plugin/official/connect-client-manifest";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { RuntimeInteractionCoordinator } from "../src/runtime/runtime-interaction-coordinator";
import {
  type ConnectRuntimeAdapter,
  completeRuntimeThreadDiscovery,
  type RuntimeModelOption,
} from "../src/runtime/types";
import { WorkBuddyDiscoveryError, type WorkBuddyDiscoveryFailureCode } from "../src/runtime/workbuddy-task-discovery";
import type { BindingRuntimeHandle } from "../src/service/binding-runtime";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { fixedRuntimeAdapter, pluginBinding } from "./runtime-adapter-fixture";

const openHandles: ClientInterfaceHandle[] = [];
const openStores: ConnectStateStore[] = [];

async function startClientInterface(
  options: ConnectClientApplicationServices & Omit<ConnectClientOwnedInterfaceOptions, "applicationPort">,
): Promise<ClientInterfaceHandle> {
  const { assetsPath, hostname, port, managedWebApp, serverFactory, ...services } = options;
  return await startOwnedClientInterface({
    applicationPort: createCoreConnectClientApplicationPort(() => services),
    assetsPath,
    hostname,
    port,
    managedWebApp,
    ...(serverFactory ? { serverFactory } : {}),
  });
}

afterEach(async () => {
  await Promise.allSettled(openHandles.splice(0).map(async (handle) => await handle.stop()));
  await Promise.allSettled(openStores.splice(0).map(async (store) => await store.close()));
});

describe("Connect Client Interface", () => {
  it("serves the Client while Runtime-backed catalog initialization completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-readiness-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect readiness</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await store.upsertActivation({
      localAgentId: "codex",
      accessToken: "token-codex",
      refreshToken: null,
      serverAgentId: "agent-codex",
      userId: "usr_agent_codex",
      ownerUserId: "usr_owner",
      conversationId: "chat-owner-agent",
    });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    let publishDiscoveryStarted: () => void = () => undefined;
    const discoveryStarted = new Promise<void>((resolve) => {
      publishDiscoveryStarted = resolve;
    });
    let releaseDiscovery: () => void = () => undefined;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const registry = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        discoverAllThreads: async () => {
          publishDiscoveryStarted();
          await discoveryGate;
          return completeRuntimeThreadDiscovery([]);
        },
        discoverArchivedThreads: async () => completeRuntimeThreadDiscovery([], { reason: "archived" }),
        start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      }),
    ]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const port = 47_890;
    const starting = startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimes: [
        {
          agentId: "codex",
          websocketUrl: config.websocketUrl,
          deviceId: "device-readiness",
          close: async () => undefined,
        },
      ],
      assetsPath,
      hostname: "127.0.0.1",
      port,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    for (let attempt = 0; attempt < 50 && !fetchHandler; attempt += 1) await Bun.sleep(1);
    if (!fetchHandler) throw new Error("Client listener was blocked by catalog initialization");
    await discoveryStarted;

    let handle: ClientInterfaceHandle | null = null;
    try {
      const origin = `http://127.0.0.1:${port}`;
      const document = await localRequest(fetchHandler, origin, "/");
      expect(document.status).toBe(200);
      const readyBootstrap = await localRequest(fetchHandler, origin, "/client/v1/bootstrap");
      expect(readyBootstrap.status).toBe(200);
      await expect(Promise.race([starting.then(() => "ready"), Bun.sleep(10).then(() => "waiting")])).resolves.toBe(
        "ready",
      );
      handle = await starting;
      releaseDiscovery();
      const bootstrap = await localRequest(fetchHandler, handle.origin, "/client/v1/bootstrap");
      expect(bootstrap.status).toBe(200);
      const eventBatch = await localRequest(fetchHandler, handle.origin, "/client/v1/events/batch?after=0");
      expect(eventBatch.status).toBe(200);
      const events = (await eventBatch.json()) as { events: Array<{ type: string }> };
      expect(events.events.some((event) => event.type === "catalog.changed")).toBe(true);
    } finally {
      releaseDiscovery();
      handle ??= await starting;
      await handle.stop();
      await registry.close();
      await store.close();
    }
  });

  it("closes an early Client listener when core initialization fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-readiness-failure-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect readiness failure</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    let publishCoreInitializationStarted: () => void = () => undefined;
    const coreInitializationStarted = new Promise<void>((resolve) => {
      publishCoreInitializationStarted = resolve;
    });
    let releaseCoreInitialization: () => void = () => undefined;
    const coreInitializationGate = new Promise<void>((resolve) => {
      releaseCoreInitialization = resolve;
    });
    store.listRecoverableTurnOutbox = mock(async () => {
      publishCoreInitializationStarted();
      await coreInitializationGate;
      throw new Error("Client core initialization failed");
    });
    await store.upsertActivation({
      localAgentId: "codex",
      accessToken: "token-codex",
      refreshToken: null,
      serverAgentId: "agent-codex",
      userId: "usr_agent_codex",
      ownerUserId: "usr_owner",
      conversationId: "chat-owner-agent",
    });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const registry = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        discoverAllThreads: async () => completeRuntimeThreadDiscovery([]),
        discoverArchivedThreads: async () => completeRuntimeThreadDiscovery([], { reason: "archived" }),
        start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      }),
    ]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const stop = mock(async () => undefined);
    const port = 47_889;
    const starting = startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimes: [
        {
          agentId: "codex",
          websocketUrl: config.websocketUrl,
          deviceId: "device-readiness-failure",
          close: async () => undefined,
        },
      ],
      assetsPath,
      hostname: "127.0.0.1",
      port,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop };
      },
    });
    await coreInitializationStarted;

    try {
      if (!fetchHandler) throw new Error("Client listener was not created before failing initialization");
      const document = await localRequest(fetchHandler, `http://127.0.0.1:${port}`, "/");
      expect(document.status).toBe(200);
      releaseCoreInitialization();
      await expect(starting).rejects.toThrow("Client core initialization failed");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(true);
    } finally {
      releaseCoreInitialization();
      await starting.catch(() => undefined);
      await registry.close();
      await store.close();
    }
  });

  it("joins every parallel warming task before reporting Client initialization failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-warming-join-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect warming join</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    store.listIncompleteSessionLifecycleOperations = mock(async () => {
      throw new Error("lifecycle warming failed");
    });
    let publishCleanupStarted: () => void = () => undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      publishCleanupStarted = resolve;
    });
    let releaseCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    store.deleteExpiredClientCommands = mock(async () => {
      publishCleanupStarted();
      await cleanupGate;
    });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    const registry = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      }),
    ]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const stop = mock(async () => undefined);
    const starting = startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimes: [],
      assetsPath,
      hostname: "127.0.0.1",
      port: 47_888,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: () => ({ stop }),
    });
    const observed = starting.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await cleanupStarted;

    try {
      await expect(Promise.race([observed, Bun.sleep(20).then(() => "waiting" as const)])).resolves.toBe("waiting");
      expect(stop).not.toHaveBeenCalled();
      releaseCleanup();
      const result = await observed;
      expect(result).toBeInstanceOf(Error);
      expect(result).toMatchObject({ message: "lifecycle warming failed" });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(true);
    } finally {
      releaseCleanup();
      await observed;
      await registry.close();
      await store.close();
    }
  });

  it("serves direct loopback snapshots and local turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-interface-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect test</title>");
    const sessionRefs = ["ABCDEFGH", "BCDEFGHJ", "CDEFGHJK", "DEFGHJKM"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => sessionRefs.shift() ?? "EFGHJKMN",
    });
    openStores.push(store);
    await store.upsertActivation({
      localAgentId: "codex",
      accessToken: "token-codex",
      refreshToken: null,
      serverAgentId: "agent-codex",
      userId: "usr_agent_codex",
      ownerUserId: "usr_owner",
      conversationId: "chat-owner-agent",
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      runtimeSessionId: "thread-1",
      name: "First session",
      hasMessages: true,
      isCurrent: true,
    });
    const discoveredWorkspaceRoot = join(directory, "discovered-workspace");
    await mkdir(discoveredWorkspaceRoot);
    const session = await store.getCurrentRuntimeSession("chat-1", "codex");
    if (!session) throw new Error("test session was not created");
    let isArchived = false;
    let isDeleted = false;
    const lifecycleCalls: string[] = [];
    const runtimeBindingIds = new Set<string | undefined>();
    let blockConcurrentModelList = false;
    let signalConcurrentModelList: () => void = () => undefined;
    const concurrentModelListStarted = new Promise<void>((resolve) => {
      signalConcurrentModelList = resolve;
    });
    let releaseConcurrentModelList: () => void = () => undefined;
    const concurrentModelListReleased = new Promise<void>((resolve) => {
      releaseConcurrentModelList = resolve;
    });
    const runtimeCatalogListeners = new Set<() => void>();
    const listModels = mock(
      async (
        binding: Parameters<NonNullable<ConnectRuntimeAdapter["listModels"]>>[0],
      ): Promise<RuntimeModelOption[]> => {
        runtimeBindingIds.add(agentBindingIdentity(binding));
        if (blockConcurrentModelList) {
          blockConcurrentModelList = false;
          signalConcurrentModelList();
          await concurrentModelListReleased;
        }
        return [
          {
            id: "gpt-default",
            selection: { model: "gpt-default" },
            displayName: "Default model",
            description: "Runtime default",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium", "high"],
            inputModalities: ["text", "image"],
          },
          {
            id: "gpt-deep",
            selection: { model: "gpt-deep" },
            displayName: "Deep model",
            description: "Long tasks",
            isDefault: false,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["high", "xhigh"],
            inputModalities: ["text", "image"],
            turnSubmissionCapability: {
              prompt: { allowed: true, required: false, maxCharacters: 8_000 },
              attachments: {
                allowedKinds: ["image"],
                allowedMediaTypes: ["image/png"],
                maxCount: 2,
                maxBytesEach: 1_024,
                maxBytesTotal: 1_500,
              },
            },
          },
        ];
      },
    );
    const listSessionOptions = mock(
      async (binding: Parameters<NonNullable<ConnectRuntimeAdapter["listSessionOptions"]>>[0]) => {
        runtimeBindingIds.add(agentBindingIdentity(binding));
        return [];
      },
    );
    const summary = { runtimeThreadId: "thread-1", name: "First session", updatedAt: 1 };
    const discoveredSummary = {
      runtimeThreadId: "thread-discovered",
      name: "Discovered workspace session",
      updatedAt: 2,
      workspaceIdentity: {
        key: discoveredWorkspaceRoot,
        kind: "persistent" as const,
        localRoot: discoveredWorkspaceRoot,
      },
    };
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels,
      listSessionOptions,
      onCatalogsChanged: (listener) => {
        runtimeCatalogListeners.add(listener);
        return () => runtimeCatalogListeners.delete(listener);
      },
      listSkills: async (binding) => {
        runtimeBindingIds.add(agentBindingIdentity(binding));
        return [
          {
            id: "codex:grill-with-docs",
            name: "grill-with-docs",
            description: "Challenge a proposal against primary documentation",
          },
        ];
      },
      listCommands: async (binding) => {
        runtimeBindingIds.add(agentBindingIdentity(binding));
        return [
          { id: "codex-command:compact", name: "compact", description: "Compact the Session" },
          { id: "codex-command:grill-with-docs", name: "grill-with-docs", description: "Runtime command" },
        ];
      },
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery(!isArchived && !isDeleted ? [summary, discoveredSummary] : [discoveredSummary]),
      discoverArchivedThreads: async () =>
        completeRuntimeThreadDiscovery(isArchived && !isDeleted ? [{ ...summary, isArchived: true }] : [], {
          reason: "archived",
        }),
      archiveThread: async (_binding, threadId) => {
        lifecycleCalls.push(`archive:${threadId}`);
        isArchived = true;
      },
      unarchiveThread: async (_binding, threadId) => {
        lifecycleCalls.push(`unarchive:${threadId}`);
        isArchived = false;
      },
      deleteThread: async (_binding, threadId) => {
        lifecycleCalls.push(`delete:${threadId}`);
        isDeleted = true;
      },
      readActivity: async () => ({
        completeness: "complete",
        limitations: [],
        activities: [
          {
            id: "user-1",
            position: "0",
            parentId: null,
            kind: "user",
            text: "hello",
            state: "complete",
            source: "history",
          },
          {
            id: "agent-1",
            position: "1",
            parentId: null,
            kind: "assistant",
            text: "world",
            state: "complete",
            source: "history",
          },
          {
            id: "subagent-1",
            position: "2",
            parentId: null,
            kind: "subagent",
            text: "Scout · researcher",
            state: "complete",
            source: "history",
            data: { title: "Scout", role: "researcher", activityKind: "started" },
            children: [
              {
                id: "child-user",
                position: "2.0",
                parentId: "subagent-1",
                kind: "user",
                text: "investigate",
                state: "complete",
                source: "history",
              },
              {
                id: "child-agent",
                position: "2.1",
                parentId: "subagent-1",
                kind: "assistant",
                text: "found it",
                state: "complete",
                source: "history",
              },
            ],
          },
        ],
      }),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    config.defaultAgent = "codex";
    config.stateDbPath = store.dbPath;
    const enqueueClientTurn = mock(
      async (
        sessionRef: string,
        _prompt: string,
        _media: import("../src/runtime/types").ConnectRuntimeMedia[],
        _selection?: import("../src/runtime/types").RuntimeSlashSelection | null,
      ) => ({
        turnId: "turn-123",
        sessionRef,
      }),
    );
    const queuedTurns: import("../src/runtime/types").QueuedClientTurn[] = [];
    const cancelQueuedClientTurn = mock((_sessionRef: string, turnId: string) => {
      const index = queuedTurns.findIndex((turn) => turn.turnId === turnId);
      if (index < 0) return false;
      queuedTurns.splice(index, 1);
      return true;
    });
    const runtime: BindingRuntimeHandle = {
      agentId: "codex",
      websocketUrl: config.websocketUrl,
      deviceId: "device-1",
      enqueueClientTurn,
      queuedClientTurns: () => queuedTurns,
      cancelQueuedClientTurn,
      close: async () => undefined,
    };
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const runtimeInteractions = new RuntimeInteractionCoordinator(projection);
    const port = 47_891;
    const configPath = join(directory, "config.json");
    const configMutations = new ConnectConfigMutationCoordinator(config, configPath);
    let providerMutationStarted = false;
    const pluginManager = {
      configMutations,
      list: async () => [],
      listPublishedClientExtensions: async () => [],
      upsertBindingProvider: async (bindingId: string, candidate: (typeof config.agents)[string]) =>
        await configMutations.runExclusive(async (commitConfig) => {
          providerMutationStarted = true;
          const binding = await commitConfig((latest) => {
            latest.agents[bindingId] = structuredClone(candidate);
            return structuredClone(candidate);
          });
          return { binding, modes: ["workspace-write"] };
        }),
    } as unknown as ConnectPluginManagement;
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const handle = await startClientInterface({
      config,
      configPath,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimeInteractions,
      pluginManager,
      runtimes: [runtime],
      assetsPath,
      hostname: "127.0.0.1",
      port,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    openHandles.push(handle);
    if (!fetchHandler) throw new Error("test Client Interface did not expose a request handler");

    const document = await localRequest(fetchHandler, handle.origin, "/");
    expect(document.status).toBe(200);
    const contentSecurityPolicy = document.headers.get("content-security-policy") ?? "";
    expect(contentSecurityPolicy).toContain("script-src 'self' blob:; script-src-attr 'none'");
    expect(contentSecurityPolicy).toContain("style-src-elem 'self'; style-src-attr 'unsafe-inline'");
    expect(contentSecurityPolicy).not.toContain("script-src 'self' blob: 'unsafe-inline'");
    const bootstrap = await localRequest(fetchHandler, handle.origin, "/client/v1/bootstrap");
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      apiVersion: 1,
      bindings: [
        {
          bindingId: "codex",
          displayName: "Codex",
          clawChatUserId: "usr_agent_codex",
          runtimeKind: "codex",
        },
      ],
      capabilities: { localTurns: true, runtimeInteractions: true },
      clientExtensions: {
        hash: expect.any(String),
        epoch: expect.any(String),
        extensions: [],
      },
    });
    const slashSuggestions = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/slash-suggestions`,
    );
    expect(slashSuggestions.status).toBe(200);
    await expect(slashSuggestions.json()).resolves.toEqual({
      supported: true,
      entries: [
        {
          id: "codex-command:compact",
          kind: "command",
          name: "compact",
          description: "Compact the Session",
        },
        {
          id: "codex-command:grill-with-docs",
          kind: "command",
          name: "grill-with-docs",
          description: "Runtime command",
        },
        {
          id: "codex:grill-with-docs",
          kind: "skill",
          name: "grill-with-docs",
          description: "Challenge a proposal against primary documentation",
        },
      ],
    });
    const staleClientExtensionMutation = await localRequest(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/codex/preferences",
      {
        method: "PATCH",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "stale_client_extension_request",
          clientExtensionEpoch: "sha256-stale",
          displayName: "Stale Extension",
        }),
      },
    );
    expect(staleClientExtensionMutation.status).toBe(409);
    expect(config.agents.codex?.displayName).toBe("Codex");

    const invalidBindingModel = await localRequest(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/codex/preferences",
      {
        method: "PATCH",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "binding_invalid_model_request",
          model: { model: "missing-model" },
          modelReasoningEffort: "high",
        }),
      },
    );
    expect(invalidBindingModel.status).toBe(400);
    expect(config.agents.codex).toMatchObject(pluginBinding({}, { displayName: "Codex" }));
    expect(config.agents.codex.model).toBeUndefined();

    const bindingEffortOnly = await localRequest(fetchHandler, handle.origin, "/client/v1/bindings/codex/preferences", {
      method: "PATCH",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "binding_effort_only_request", modelReasoningEffort: "high" }),
    });
    expect(bindingEffortOnly.status).toBe(200);
    expect(config.agents.codex).toMatchObject({ modelReasoningEffort: "high" });
    expect(config.agents.codex.model).toBeUndefined();
    const clearBindingEffort = await localRequest(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/codex/preferences",
      {
        method: "PATCH",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "binding_effort_clear_request", modelReasoningEffort: null }),
      },
    );
    expect(clearBindingEffort.status).toBe(200);

    const sessionResponse = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}`,
    );
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      model: null,
      effectiveModel: { model: "gpt-default" },
      effectiveReasoningEffort: "medium",
      modelSource: "runtime",
      modelAvailable: true,
      transcriptCompleteness: "complete",
      modelOptions: [
        { id: "gpt-default", supportedReasoningEfforts: ["medium", "high"] },
        { id: "gpt-deep", supportedReasoningEfforts: ["high", "xhigh"] },
      ],
    });
    const invalidModelPreference = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/preferences`,
      {
        method: "PATCH",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "session_invalid_model_request",
          model: { model: "missing-model" },
          reasoningEffort: "high",
        }),
      },
    );
    expect(invalidModelPreference.status).toBe(400);
    await expect(store.getRuntimeSessionByRef(session.sessionRef)).resolves.toMatchObject({
      model: null,
      reasoningEffort: null,
      runtimeSessionId: "thread-1",
    });
    const modelPreference = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/preferences`,
      {
        method: "PATCH",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "model_request",
          model: { model: "gpt-deep" },
          reasoningEffort: "xhigh",
        }),
      },
    );
    expect(modelPreference.status).toBe(200);
    await expect(modelPreference.json()).resolves.toMatchObject({
      sessionRef: session.sessionRef,
      model: { model: "gpt-deep" },
      reasoningEffort: "xhigh",
      effectiveModel: { model: "gpt-deep" },
      modelSource: "session",
    });
    await expect(store.getRuntimeSessionByRef(session.sessionRef)).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
      model: { model: "gpt-deep" },
      reasoningEffort: "xhigh",
    });
    const projectRoot = join(directory, "project-root");
    await mkdir(projectRoot);
    const registeredProject = await localRequest(fetchHandler, handle.origin, "/client/v1/workspaces", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "project_add_request",
        bindingId: "codex",
        directory: { kind: "existing-directory", rootPath: projectRoot },
      }),
    });
    expect(registeredProject.status).toBe(201);
    const registeredProjectView = (await registeredProject.json()) as { bindingId: string; workspaceRef: string };
    const reusedProject = await localRequest(fetchHandler, handle.origin, "/client/v1/workspaces", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "project_reuse_request",
        bindingId: "codex",
        directory: { kind: "existing-directory", rootPath: projectRoot },
      }),
    });
    expect(reusedProject.status).toBe(200);
    await expect(reusedProject.json()).resolves.toMatchObject({ workspaceRef: registeredProjectView.workspaceRef });
    await mkdir(join(projectRoot, "visible-directory"));
    await mkdir(join(projectRoot, ".hidden-directory"));
    const directoryListing = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/host-directories?path=${encodeURIComponent(projectRoot)}`,
    );
    expect(directoryListing.status).toBe(200);
    await expect(directoryListing.json()).resolves.toMatchObject({
      currentPath: await realpath(projectRoot),
      entries: [expect.objectContaining({ name: "visible-directory" })],
    });
    const hiddenDirectoryListing = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/host-directories?path=${encodeURIComponent(projectRoot)}&showHidden=1`,
    );
    expect(hiddenDirectoryListing.status).toBe(200);
    expect(
      ((await hiddenDirectoryListing.json()) as { entries: Array<{ name: string }> }).entries.map(
        (entry) => entry.name,
      ),
    ).toContain(".hidden-directory");
    const workspacesResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/workspaces");
    const workspaceViews = (await workspacesResponse.json()) as Array<{
      bindingId: string;
      workspaceRef: string;
      name: string;
      rootPath: string;
    }>;
    expect(workspaceViews).toHaveLength(3);
    expect(workspaceViews).toContainEqual(
      expect.objectContaining({
        workspaceRef: registeredProjectView.workspaceRef,
        name: "project-root",
        rootPath: await realpath(projectRoot),
      }),
    );
    const removedProject = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/workspaces/codex/${registeredProjectView.workspaceRef}`,
      {
        method: "DELETE",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "project_remove_request" }),
      },
    );
    expect(removedProject.status).toBe(200);
    await expect(removedProject.json()).resolves.toEqual({
      bindingId: "codex",
      workspaceRef: registeredProjectView.workspaceRef,
      removed: true,
    });
    const sessionProjectRoot = join(directory, "session-project-root");
    await mkdir(sessionProjectRoot);
    const sessionProjectResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/workspaces", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "session_project_add_request",
        bindingId: "codex",
        directory: { kind: "existing-directory", rootPath: sessionProjectRoot },
      }),
    });
    const sessionProject = (await sessionProjectResponse.json()) as { bindingId: string; workspaceRef: string };
    const sessionsBeforeInvalidCreate = await store.listAllRuntimeSessions();
    const invalidCreatedSession = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "session_invalid_create_request",
        prompt: "This must not run",
        bindingId: "codex",
        workspace: { kind: "existing", workspaceRef: sessionProject.workspaceRef },
        name: "Invalid model",
        mode: "workspace-write",
        model: { model: "missing-model" },
        reasoningEffort: "high",
      }),
    });
    expect(invalidCreatedSession.status).toBe(400);
    expect(await store.listAllRuntimeSessions()).toHaveLength(sessionsBeforeInvalidCreate.length);
    const createdSession = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "session_create_request",
        bindingId: "codex",
        workspace: { kind: "existing", workspaceRef: sessionProject.workspaceRef },
        name: "Planned from Client",
        mode: "workspace-write",
        model: { model: "gpt-deep" },
        reasoningEffort: "xhigh",
      }),
    });
    expect(createdSession.status).toBe(201);
    const createdSessionView = (await createdSession.json()) as {
      sessionRef: string;
      workspaceRef: string;
      mode: string;
      model: { model: string };
      reasoningEffort: string;
      runtimeThreadAvailable: boolean;
      turnSubmissionCapability: {
        prompt: { maxCharacters: number };
        attachments: {
          allowedMediaTypes: string[];
          maxCount: number;
          maxBytesEach: number;
          maxBytesTotal: number;
        };
      };
    };
    expect(createdSessionView).toMatchObject({
      workspaceRef: sessionProject.workspaceRef,
      mode: "workspace-write",
      model: { model: "gpt-deep" },
      reasoningEffort: "xhigh",
      runtimeThreadAvailable: false,
      turnSubmissionCapability: {
        prompt: { maxCharacters: 8_000 },
        attachments: {
          allowedMediaTypes: ["image/png"],
          maxCount: 2,
          maxBytesEach: 1_024,
          maxBytesTotal: 1_500,
        },
      },
    });
    await expect(store.getRuntimeSessionByRef(createdSessionView.sessionRef)).resolves.toMatchObject({
      workspaceRef: sessionProject.workspaceRef,
      mode: "workspace-write",
      model: { model: "gpt-deep" },
      reasoningEffort: "xhigh",
      runtimeSessionId: null,
    });
    const catalogResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/session-catalog?refresh=1");
    const catalogView = (await catalogResponse.json()) as {
      bindings: Array<{
        entries: Array<{ sessionRef: string; workspaceRef: string | null; workspaceName: string | null }>;
      }>;
    };
    const discoveredWorkspace = catalogView.bindings[0]?.entries.find(
      (entry) => entry.workspaceName === "discovered-workspace",
    );
    expect(discoveredWorkspace?.workspaceRef).toBeTruthy();
    if (!discoveredWorkspace) throw new Error("discovered workspace Session was not cataloged");
    await expect(store.getRuntimeSessionByRef(discoveredWorkspace.sessionRef)).resolves.toBeNull();
    const discoveredSpecPath = join(discoveredWorkspaceRoot, "discovered-spec.md");
    await writeFile(discoveredSpecPath, "# Discovered Runtime Thread spec\n");
    const discoveredWorkspaceFile = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${discoveredWorkspace.sessionRef}/files?path=${encodeURIComponent(discoveredSpecPath)}`,
    );
    expect(discoveredWorkspaceFile.status).toBe(200);
    await expect(discoveredWorkspaceFile.text()).resolves.toBe("# Discovered Runtime Thread spec\n");
    const workspaceSession = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "workspace_session_create_request",
        bindingId: "codex",
        workspace: { kind: "existing", workspaceRef: discoveredWorkspace.workspaceRef },
        name: "Created in discovered workspace",
        mode: "workspace-write",
        model: null,
        reasoningEffort: null,
      }),
    });
    expect(workspaceSession.status).toBe(201);
    const workspaceSessionView = (await workspaceSession.json()) as { sessionRef: string; workspaceRef: string };
    const materializedWorkspace = await store.getWorkspace("codex", workspaceSessionView.workspaceRef);
    expect(materializedWorkspace?.rootPath).toBe(await realpath(discoveredWorkspaceRoot));
    expect(enqueueClientTurn).not.toHaveBeenCalled();
    const transcript = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/transcript`,
    );
    expect(transcript.status).toBe(200);
    await expect(transcript.json()).resolves.toMatchObject({
      sessionRef: session.sessionRef,
      completeness: "complete",
      blocks: [
        { type: "message", role: "user", markdown: "hello", runtimeSource: "history" },
        { type: "message", role: "assistant", markdown: "world", runtimeSource: "history" },
        {
          type: "subagent",
          title: "Scout",
          role: "researcher",
          activityKind: "started",
          blocks: [
            { type: "message", role: "user", markdown: "investigate" },
            { type: "message", role: "assistant", markdown: "found it" },
          ],
        },
      ],
    });

    const runtimeWorkspace = await new WorkspaceCatalog(store).resolveWorkspace(session);
    const specDirectory = join(runtimeWorkspace.workingDirectory, ".scratch", "example-spec");
    const specPath = join(specDirectory, "spec.md");
    await mkdir(specDirectory, { recursive: true });
    await writeFile(specPath, "# Example spec\n\nWorkspace-scoped content.\n");
    const workspaceFile = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/files?path=${encodeURIComponent(specPath)}`,
    );
    expect(workspaceFile.status).toBe(200);
    expect(workspaceFile.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(workspaceFile.headers.get("content-disposition")).toContain("spec.md");
    await expect(workspaceFile.text()).resolves.toBe("# Example spec\n\nWorkspace-scoped content.\n");

    const imagePath = join(specDirectory, "mockup.png");
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imagePath, imageBytes);
    const workspaceImage = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/files?path=${encodeURIComponent(imagePath)}`,
    );
    expect(workspaceImage.status).toBe(200);
    expect(workspaceImage.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await workspaceImage.arrayBuffer())).toEqual(imageBytes);

    const htmlPath = join(specDirectory, "prototype.html");
    await writeFile(htmlPath, "<script>window.top.location='https://example.com'</script>");
    const workspaceHtml = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/files?path=${encodeURIComponent(htmlPath)}`,
    );
    expect(workspaceHtml.status).toBe(200);
    expect(workspaceHtml.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(workspaceHtml.headers.get("content-security-policy")).toContain("script-src 'none'");

    const outsideSpecPath = join(directory, "outside.md");
    await writeFile(outsideSpecPath, "# Outside\n");
    const outsideWorkspaceFile = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/files?path=${encodeURIComponent(outsideSpecPath)}`,
    );
    expect(outsideWorkspaceFile.status).toBe(403);
    const linkedOutsideSpecPath = join(specDirectory, "linked-outside.md");
    await symlink(outsideSpecPath, linkedOutsideSpecPath);
    const linkedOutsideWorkspaceFile = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/files?path=${encodeURIComponent(linkedOutsideSpecPath)}`,
    );
    expect(linkedOutsideWorkspaceFile.status).toBe(403);
    const environmentPath = join(runtimeWorkspace.workingDirectory, ".env");
    await writeFile(environmentPath, "SECRET_TOKEN=not-readable-through-liveware\n");
    const unsupportedWorkspaceFile = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/files?path=${encodeURIComponent(environmentPath)}`,
    );
    expect(unsupportedWorkspaceFile.status).toBe(415);

    const eventCursor = await store.getClientEventCursor();
    await projection.appendUserMessage({
      sessionRef: session.sessionRef,
      text: "from ClawChat",
      origin: "clawchat",
      author: "usr_opaque",
      sender: { id: "usr_opaque", displayName: "Alice" },
      conversationType: "group",
      media: [
        {
          kind: "image",
          url: "https://media.clawling.chat/media/example.jpg",
          name: "example.jpg",
          mime: "image/jpeg",
          width: 640,
          height: 480,
        },
      ],
    });
    const eventBatch = await localRequest(fetchHandler, handle.origin, `/client/v1/events/batch?after=${eventCursor}`);
    expect(eventBatch.status).toBe(200);
    const eventBatchView = (await eventBatch.json()) as {
      events: Array<{ type: string; cursor: number; previousCursor: number; [key: string]: unknown }>;
    };
    expect(eventBatchView.events.find((event) => event.type === "transcript.block-upserted")).toMatchObject({
      type: "transcript.block-upserted",
      sessionRef: session.sessionRef,
      block: {
        type: "message",
        origin: "clawchat",
        markdown: "from ClawChat",
        sender: { id: "usr_opaque", displayName: "Alice" },
        conversationType: "group",
        media: [
          {
            kind: "image",
            url: "https://media.clawling.chat/media/example.jpg",
            name: "example.jpg",
          },
        ],
      },
    });
    expect(
      eventBatchView.events.every(
        (event, index, events) => index === 0 || event.previousCursor === events[index - 1]?.cursor,
      ),
    ).toBe(true);

    const submissionBody = (prompt = "/grill-with-docs from web") => {
      const body = new FormData();
      body.append("prompt", prompt);
      body.append("selectionKind", "skill");
      body.append("selectionId", "codex:grill-with-docs");
      body.append("selectionName", "grill-with-docs");
      body.append("attachments", new File(["photo"], "photo.png", { type: "image/png" }));
      return body;
    };
    const modelReadsBeforeSubmission = listModels.mock.calls.length;
    const optionReadsBeforeSubmission = listSessionOptions.mock.calls.length;
    const turn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_123`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body: submissionBody(),
      },
    );
    expect(turn.status).toBe(202);
    expect(listModels.mock.calls.length - modelReadsBeforeSubmission).toBe(0);
    expect(listSessionOptions.mock.calls.length - optionReadsBeforeSubmission).toBe(0);
    await expect(turn.json()).resolves.toEqual({
      submissionId: "request_123",
      messageId: "turn_request_123_user",
      sessionRef: session.sessionRef,
      state: "pending",
      turnId: null,
      error: null,
    });
    await waitFor(() => enqueueClientTurn.mock.calls.length >= 1);
    queuedTurns.push({
      turnId: "turn-queued",
      sessionRef: session.sessionRef,
      prompt: "edit this queued prompt",
      selection: null,
      attachments: [],
      createdAt: new Date(0).toISOString(),
    });
    const queuedSession = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}?refresh=1`,
    );
    await expect(queuedSession.json()).resolves.toMatchObject({
      queuedTurns: [{ turnId: "turn-queued", prompt: "edit this queued prompt" }],
    });
    const withdrawn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/queued-turns/turn-queued/withdraw`,
      {
        method: "POST",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "withdraw_queued_1" }),
      },
    );
    expect(withdrawn.status).toBe(200);
    await expect(withdrawn.json()).resolves.toEqual({
      cancelled: true,
      sessionRef: session.sessionRef,
      turnId: "turn-queued",
    });
    expect(cancelQueuedClientTurn).toHaveBeenCalledWith(session.sessionRef, "turn-queued");
    expect(enqueueClientTurn).toHaveBeenCalledWith(
      session.sessionRef,
      "/grill-with-docs from web",
      [
        expect.objectContaining({
          kind: "image",
          name: "photo.png",
          mime: "image/png",
          size: 5,
          stagedPath: expect.any(String),
        }),
      ],
      {
        kind: "skill",
        id: "codex:grill-with-docs",
        name: "grill-with-docs",
      },
      expect.any(AbortSignal),
      "request_123",
    );
    const acceptedMedia = enqueueClientTurn.mock.calls[0]?.[2]?.[0];
    if (!acceptedMedia?.stagedPath) throw new Error("accepted media was not Connect-staged");
    await expect(Bun.file(acceptedMedia.stagedPath).text()).resolves.toBe("photo");
    const renderedMedia = await localRequest(fetchHandler, handle.origin, acceptedMedia.url);
    expect(renderedMedia.status).toBe(200);
    expect(renderedMedia.headers.get("content-type")).toBe("image/png");
    await expect(renderedMedia.text()).resolves.toBe("photo");

    const replayedTurn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_123`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body: submissionBody(),
      },
    );
    expect(replayedTurn.status).toBe(202);
    expect(enqueueClientTurn).toHaveBeenCalledTimes(1);

    const unknownSlashBody = new FormData();
    unknownSlashBody.append("prompt", "/not-a-skill keep this as ordinary text");
    const unknownSlashTurn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_unknown_slash`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body: unknownSlashBody,
      },
    );
    expect(unknownSlashTurn.status).toBe(202);
    await waitFor(() => enqueueClientTurn.mock.calls.length >= 2);
    expect(enqueueClientTurn).toHaveBeenLastCalledWith(
      session.sessionRef,
      "/not-a-skill keep this as ordinary text",
      [],
      null,
      expect.any(AbortSignal),
      "request_unknown_slash",
    );

    const knownSlashBody = new FormData();
    knownSlashBody.append("prompt", "  /grill-with-docs preserve the authored prompt  ");
    const knownSlashTurn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_known_slash`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body: knownSlashBody,
      },
    );
    expect(knownSlashTurn.status).toBe(202);
    await waitFor(() => enqueueClientTurn.mock.calls.length >= 3);
    expect(enqueueClientTurn).toHaveBeenLastCalledWith(
      session.sessionRef,
      "  /grill-with-docs preserve the authored prompt  ",
      [],
      {
        kind: "command",
        id: "codex-command:grill-with-docs",
        name: "grill-with-docs",
        description: "Runtime command",
      },
      expect.any(AbortSignal),
      "request_known_slash",
    );
    expect(enqueueClientTurn).toHaveBeenCalledTimes(3);

    const acceptedOutcome = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_123`,
    );
    expect(acceptedOutcome.status).toBe(200);
    await expect(acceptedOutcome.json()).resolves.toMatchObject({ state: "accepted", turnId: "turn-123" });

    const acceptedCancelRace = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_123`,
      { method: "DELETE", headers: { origin: handle.origin } },
    );
    expect(acceptedCancelRace.status).toBe(409);
    await expect(acceptedCancelRace.json()).resolves.toMatchObject({
      error: { code: "submission-not-cancellable" },
    });

    const conflictingSubmission = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_123`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body: submissionBody("/grill-with-docs different content"),
      },
    );
    expect(conflictingSubmission.status).toBe(409);
    expect(enqueueClientTurn).toHaveBeenCalledTimes(3);

    const conflictingRequestId = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turns/turn-123/cancel`,
      {
        method: "POST",
        headers: {
          origin: handle.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId: "request_123" }),
      },
    );
    expect(conflictingRequestId.status).toBe(409);

    const approvalResult = runtimeInteractions.request(
      {
        kind: "approval",
        action: "command",
        title: "Run command?",
        description: "git push",
        command: "git push",
        options: [
          { id: "approve-once", label: "Approve once" },
          { id: "deny", label: "Deny" },
        ],
      },
      { sessionRef: session.sessionRef, turnId: "turn-approval", origin: "client" },
    );
    while ((await store.listPendingRuntimeInteractions(session.sessionRef)).length === 0) await Bun.sleep(0);
    const pendingViewResponse = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}`,
    );
    await expect(pendingViewResponse.json()).resolves.toMatchObject({
      pendingInteractions: [
        {
          interactionType: "approval",
          responseState: "pending",
          command: "git push",
        },
      ],
    });
    const blockedTurn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_blocked_by_approval`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body: (() => {
          const body = new FormData();
          body.append("prompt", "must wait");
          return body;
        })(),
      },
    );
    expect(blockedTurn.status).toBe(202);
    const requestHandler = fetchHandler;
    await waitFor(async () => {
      const outcome = await localRequest(
        requestHandler,
        handle.origin,
        `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_blocked_by_approval`,
      );
      const view = (await outcome.json()) as { state?: string; error?: { code?: string } };
      return view.state === "failed" && view.error?.code === "runtime-interaction-pending";
    });
    const stagingEntries = await readdir(join(directory, "turn-submissions"));
    expect(stagingEntries.some((entry) => entry.startsWith("request_blocked_by_approval-"))).toBe(true);
    const pending = (await store.listPendingRuntimeInteractions(session.sessionRef))[0];
    if (!pending) throw new Error("pending interaction was not projected");
    const approval = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/runtime-interactions/${pending.interactionId}/respond`,
      {
        method: "POST",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "approval_response", optionId: "approve-once" }),
      },
    );
    expect(approval.status).toBe(200);
    await expect(approval.json()).resolves.toMatchObject({
      responseState: "resolved",
      resolvedOptionId: "approve-once",
      resolvedBy: "client",
    });
    await expect(approvalResult).resolves.toEqual({ kind: "approval", optionId: "approve-once" });

    const rejected = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_rejected`,
      {
        method: "POST",
        headers: { origin: "http://evil.invalid" },
        body: "{}",
      },
    );
    expect(rejected.status).toBe(403);

    const livewareMutation = await localRequest(fetchHandler, handle.origin, "/client/v1/not-found", {
      method: "POST",
      headers: { origin: "https://app-connect-test.apps.clawling.io", "sec-fetch-site": "same-origin" },
    });
    expect(livewareMutation.status).toBe(403);

    const archived = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/archive`,
      {
        method: "POST",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "archive_request" }),
      },
    );
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toEqual({ sessionRef: session.sessionRef, archived: true });
    const archivedView = await localRequest(fetchHandler, handle.origin, `/client/v1/sessions/${session.sessionRef}`);
    await expect(archivedView.json()).resolves.toMatchObject({ isArchived: true });

    const restored = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/unarchive`,
      {
        method: "POST",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "unarchive_request" }),
      },
    );
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toEqual({ sessionRef: session.sessionRef, archived: false });

    const deleted = await localRequest(fetchHandler, handle.origin, `/client/v1/sessions/${session.sessionRef}`, {
      method: "DELETE",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "delete_request" }),
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ sessionRef: session.sessionRef, deleted: true });
    expect(lifecycleCalls).toEqual(["archive:thread-1", "unarchive:thread-1", "delete:thread-1"]);
    blockConcurrentModelList = true;
    for (const listener of runtimeCatalogListeners) listener();
    const preferenceMutation = localRequest(fetchHandler, handle.origin, "/client/v1/bindings/codex/preferences", {
      method: "PATCH",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "concurrent_binding_preference",
        displayName: "Concurrent preference",
        model: { model: "gpt-default" },
      }),
    });
    await concurrentModelListStarted;
    const providerBinding = pluginBinding({ instance: "concurrent-provider" }, { displayName: "Concurrent provider" });
    const providerMutation = pluginManager.upsertBindingProvider("concurrent-provider", providerBinding);
    expect(providerMutationStarted).toBe(false);
    releaseConcurrentModelList();
    const [preferenceResponse, providerResult] = await Promise.all([preferenceMutation, providerMutation]);
    expect(preferenceResponse.status).toBe(200);
    expect(providerResult.binding).toEqual(providerBinding);
    expect(config.agents.codex).toMatchObject({
      displayName: "Concurrent preference",
      model: { model: "gpt-default" },
    });
    expect(config.agents["concurrent-provider"]).toEqual(providerBinding);
    await expect(loadConfig(configPath)).resolves.toEqual(config);
    expect([...runtimeBindingIds]).toEqual(["codex"]);
    await expect(store.getSessionRefTarget(session.sessionRef)).resolves.toBeNull();
  });

  it.each([
    {
      caseName: "temporarily unavailable",
      failureCode: "endpoint-unavailable",
      failureMessage: "WorkBuddy Task endpoint is temporarily unavailable",
      unavailableDetail: "WorkBuddy Task endpoint is temporarily unavailable; retry this exact Task.",
      retryable: true,
      unavailableReason: "external-ownership-unverifiable",
      expectedStatus: "offline",
    },
    {
      caseName: "in identity/replay conflict",
      failureCode: "task-identity-mismatch",
      failureMessage: "WorkBuddy ACP replay belongs to a different Task",
      unavailableDetail: "WorkBuddy Task identity/replay conflict; adoption and send remain blocked.",
      retryable: false,
      unavailableReason: "native-state-corrupt",
      expectedStatus: "error",
    },
  ] satisfies ReadonlyArray<{
    caseName: string;
    failureCode: WorkBuddyDiscoveryFailureCode;
    failureMessage: string;
    unavailableDetail: string;
    retryable: boolean;
    unavailableReason: SessionView["runtimeThreadUnavailableReason"];
    expectedStatus: SessionView["status"];
  }>)(
    "serves stored Session and Transcript views when WorkBuddy replay is $caseName",
    async ({ failureCode, failureMessage, unavailableDetail, unavailableReason, expectedStatus, retryable }) => {
      const directory = await mkdtemp(join(tmpdir(), `connect-client-workbuddy-${failureCode}-`));
      const assetsPath = join(directory, "assets");
      const workspaceRoot = join(directory, "workspace");
      await Promise.all([mkdir(assetsPath), mkdir(workspaceRoot)]);
      await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Stored WorkBuddy transcript</title>");
      const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
      openStores.push(store);
      const runtimeFailure = () => new WorkBuddyDiscoveryError(failureCode, failureMessage, { taskId: "task-native" });
      const readActivity = mock(async () => {
        throw runtimeFailure();
      });
      const registry = new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({
          kind: "workbuddy",
          modes: [],
          discoverAllThreads: async () =>
            completeRuntimeThreadDiscovery(
              [
                {
                  runtimeThreadId: "task-native",
                  name: "Stored WorkBuddy Task",
                  updatedAt: 2,
                  workspaceIdentity: {
                    key: workspaceRoot,
                    kind: "persistent",
                    localRoot: workspaceRoot,
                  },
                },
              ],
              {
                reason: "external-ownership-unverifiable",
                detail: unavailableDetail,
              },
            ),
          listCommands: async () => {
            throw runtimeFailure();
          },
          listSkills: async () => {
            throw runtimeFailure();
          },
          readActivity,
          start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
        }),
      ]);
      const config = defaultConfig();
      config.defaultAgent = "desktop";
      config.agents = {
        desktop: pluginBinding({ profile: "workbuddy-cn" }, { displayName: "WorkBuddy" }),
      };
      config.stateDbPath = store.dbPath;
      const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
      const enqueueClientTurn = mock(async (sessionRef: string) => ({ turnId: "unsafe-turn", sessionRef }));
      let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
      const port = 47_896;
      const handle = await startClientInterface({
        config,
        configPath: join(directory, "config.json"),
        stateStore: store,
        runtimeAdapters: registry,
        transcriptProjection: projection,
        runtimes: [
          {
            agentId: "desktop",
            websocketUrl: config.websocketUrl,
            deviceId: `device-${failureCode}`,
            enqueueClientTurn,
            close: async () => undefined,
          },
        ],
        assetsPath,
        hostname: "127.0.0.1",
        port,
        managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
        serverFactory: (options) => {
          fetchHandler = options.fetch;
          return { stop: async () => undefined };
        },
      });
      openHandles.push(handle);
      if (!fetchHandler) throw new Error("test Client Interface did not expose a request handler");
      const catalogResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/session-catalog");
      expect(catalogResponse.status).toBe(200);
      const catalog = (await catalogResponse.json()) as SessionCatalogView;
      const entry = catalog.bindings.find((binding) => binding.bindingId === "desktop")?.entries[0];
      if (!entry) throw new Error("WorkBuddy Task was not published to the Client catalog");
      expect(entry.allowedActions).not.toContain("adopt");
      expect(entry.runtimeThreadUnavailableDetail).toBe(unavailableDetail);

      const storedBlockId = `stored-${failureCode}`;
      await projection.appendUserMessage({
        sessionRef: entry.sessionRef,
        text: "Stored ClawChat message remains readable",
        origin: "clawchat",
        author: "usr_owner",
        id: storedBlockId,
      });

      const sessionResponse = await localRequest(
        fetchHandler,
        handle.origin,
        `/client/v1/sessions/${entry.sessionRef}`,
      );
      expect(sessionResponse.status).toBe(200);
      const sessionView = (await sessionResponse.json()) as SessionView;
      expect(sessionView).toMatchObject({
        sessionRef: entry.sessionRef,
        runtimeThreadAvailable: false,
        runtimeThreadUnavailableReason: unavailableReason,
        runtimeThreadUnavailableDetail: unavailableDetail,
        status: expectedStatus,
      });
      expect(sessionView.allowedActions).not.toContain("send");
      if (retryable) expect(sessionView.runtimeThreadUnavailableDetail).toMatch(/retry/iu);
      else expect(sessionView.runtimeThreadUnavailableDetail).not.toMatch(/retry/iu);

      const transcriptResponse = await localRequest(
        fetchHandler,
        handle.origin,
        `/client/v1/sessions/${entry.sessionRef}/transcript`,
      );
      expect(transcriptResponse.status).toBe(200);
      await expect(transcriptResponse.json()).resolves.toMatchObject({
        sessionRef: entry.sessionRef,
        blocks: [
          {
            id: storedBlockId,
            origin: "clawchat",
            plainText: "Stored ClawChat message remains readable",
          },
        ],
      });

      const slashSuggestions = await localRequest(
        fetchHandler,
        handle.origin,
        `/client/v1/sessions/${entry.sessionRef}/slash-suggestions`,
      );
      expect(slashSuggestions.status).toBe(200);
      await expect(slashSuggestions.json()).resolves.toMatchObject({
        supported: false,
        entries: [],
        availability: retryable ? "unavailable" : "conflict",
        detail: failureMessage,
      });

      const unsafeTurnBody = new FormData();
      unsafeTurnBody.append("prompt", "must remain blocked");
      const unsafeTurn = await localRequest(
        fetchHandler,
        handle.origin,
        `/client/v1/sessions/${entry.sessionRef}/turn-submissions/unsafe_${failureCode}`,
        {
          method: "POST",
          headers: { origin: handle.origin },
          body: unsafeTurnBody,
        },
      );
      expect(unsafeTurn.status).toBe(409);
      await expect(unsafeTurn.json()).resolves.toMatchObject({ error: { code: "session-state-conflict" } });
      expect(enqueueClientTurn).not.toHaveBeenCalled();
      expect(readActivity).toHaveBeenCalled();
    },
  );

  it("rolls back a Session when its response view cannot be built", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-create-retry-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect test</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    openStores.push(store);
    const config = defaultConfig();
    config.stateDbPath = store.dbPath;
    config.agents = { codex: pluginBinding({}, { displayName: "Codex" }) };
    config.defaultAgent = "codex";
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspace = await new WorkspaceCatalog(store).add("codex", workspaceRoot);
    let catalogUnavailable = true;
    const registry = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["workspace-write"],
        listModels: async () => {
          if (catalogUnavailable) throw new Error("catalog temporarily unavailable");
          return [
            {
              id: "gpt-default",
              selection: { model: "gpt-default" },
              displayName: "Default model",
              description: "Runtime default",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium", "high"],
              inputModalities: ["text"],
            },
          ];
        },
        start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      }),
    ]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const enqueueClientTurn = mock(async (sessionRef: string) => ({ turnId: "turn-created", sessionRef }));
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const port = 47_895;
    const handle = await startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimes: [
        {
          agentId: "codex",
          websocketUrl: config.websocketUrl,
          deviceId: "device-retry",
          enqueueClientTurn,
          close: async () => undefined,
        },
      ],
      assetsPath,
      hostname: "127.0.0.1",
      port,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    openHandles.push(handle);
    if (!fetchHandler) throw new Error("test Client Interface did not expose a request handler");
    const request = {
      requestId: "session_retry_request",
      bindingId: "codex",
      workspace: { kind: "existing", workspaceRef: workspace.workspaceRef },
      name: "Retry safely",
      mode: "workspace-write",
      model: null,
      reasoningEffort: null,
    };

    const failed = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(failed.status).toBe(503);
    expect(enqueueClientTurn).not.toHaveBeenCalled();
    await expect(store.listAllRuntimeSessions()).resolves.toHaveLength(0);
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
    expect((await store.listWorkspaces("codex")).filter((candidate) => candidate.source === "runtime")).toHaveLength(1);

    catalogUnavailable = false;
    const retried = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(retried.status).toBe(201);
    expect(enqueueClientTurn).not.toHaveBeenCalled();
    await expect(store.listAllRuntimeSessions()).resolves.toHaveLength(1);
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
    expect((await store.listWorkspaces("codex")).filter((candidate) => candidate.source === "runtime")).toHaveLength(1);
  });

  it("serves documents directly and rejects invalid Host headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-auth-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect test</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    openStores.push(store);
    const config = defaultConfig();
    config.stateDbPath = store.dbPath;
    const registry = new RuntimeAdapterRegistry([]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const port = 47_892;
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const handle = await startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimes: [],
      assetsPath,
      hostname: "127.0.0.1",
      port,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    openHandles.push(handle);
    if (!fetchHandler) throw new Error("test Client Interface did not expose a request handler");
    const document = await localRequest(fetchHandler, handle.origin, "/");
    expect(document.status).toBe(200);
    expect(await document.text()).toContain("Connect test");
    const invalidHost = await (fetchHandler as (request: Request) => Response | Promise<Response>)(
      new Request(handle.origin, { headers: { host: "localhost.invalid" } }),
    );
    expect(invalidHost.status).toBe(400);
  });

  it("supports explicit IPv4 LAN Host mode with request-local same-origin checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-lan-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect LAN test</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    openStores.push(store);
    const config = defaultConfig();
    config.stateDbPath = store.dbPath;
    const registry = new RuntimeAdapterRegistry([]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const port = 47_894;
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    let listeningHost = "";
    const handle = await startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimes: [],
      assetsPath,
      hostname: "0.0.0.0",
      port,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        listeningHost = options.hostname;
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    openHandles.push(handle);
    if (!fetchHandler) throw new Error("test Client Interface did not expose a request handler");
    expect(listeningHost).toBe("0.0.0.0");
    expect(handle.origin).toBe(`http://0.0.0.0:${port}`);

    const pluginAdministration = await (fetchHandler as ClientHttpServerOptions["fetch"])(
      new Request(`${handle.origin}/client/v1/plugins`, { headers: { host: `0.0.0.0:${port}` } }),
      { requestIP: () => ({ address: "127.0.0.1" }) },
    );
    expect(pluginAdministration.status).toBe(503);

    const lanOrigin = `http://192.168.1.20:${port}`;
    const document = await localRequest(fetchHandler, lanOrigin, "/");
    expect(document.status).toBe(200);

    const sameOriginMutation = await localRequest(fetchHandler, lanOrigin, "/client/v1/not-found", {
      method: "POST",
      headers: { origin: lanOrigin, "sec-fetch-site": "same-origin" },
    });
    expect(sameOriginMutation.status).toBe(404);

    const wrongOrigin = await localRequest(fetchHandler, lanOrigin, "/client/v1/not-found", {
      method: "POST",
      headers: { origin: `http://192.168.1.21:${port}`, "sec-fetch-site": "same-origin" },
    });
    expect(wrongOrigin.status).toBe(403);

    const hostnameRebinding = await (fetchHandler as (request: Request) => Response | Promise<Response>)(
      new Request(lanOrigin, { headers: { host: `attacker.example:${port}` } }),
    );
    expect(hostnameRebinding.status).toBe(400);
  });

  it("restricts a Binding-scoped Client gateway and Workspace Catalog to its Agent Binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-binding-scope-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Scoped Connect test</title>");
    const refs = ["PERSNAL2", "WRKREF23"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => refs.shift() ?? "NEWREF34",
    });
    openStores.push(store);
    await store.insertWorkspace({
      bindingId: "personal",
      workspaceRef: "PERSONAL",
      runtimeIdentityKey: null,
      source: "runtime",
      name: "Personal Workspace",
      rootPath: directory,
      selectable: true,
    });
    await store.insertWorkspace({
      bindingId: "work",
      workspaceRef: "WORKSPCE",
      runtimeIdentityKey: null,
      source: "runtime",
      name: "Work Workspace",
      rootPath: directory,
      selectable: true,
    });
    await store.upsertRuntimeSession({
      chatId: "personal-chat",
      sessionId: "personal-session",
      agentId: "personal",
      runtimeSessionId: "personal-thread",
      name: "Personal Session",
      workspaceRef: "PERSONAL",
      hasMessages: true,
    });
    await store.upsertRuntimeSession({
      chatId: "work-chat",
      sessionId: "work-session",
      agentId: "work",
      runtimeSessionId: "work-thread",
      name: "Work Session",
      workspaceRef: "WORKSPCE",
      hasMessages: true,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels: async () => [
        {
          id: "scoped-model",
          selection: { model: "scoped-model" },
          displayName: "Scoped model",
          description: "Supports scoped attachment tests",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          inputModalities: ["text", "image"],
          turnSubmissionCapability: {
            prompt: { allowed: true, required: false, maxCharacters: 8_000 },
            attachments: {
              allowedKinds: ["image"],
              allowedMediaTypes: ["image/png"],
              maxCount: 1,
              maxBytesEach: 1_024,
              maxBytesTotal: 1_024,
            },
          },
        },
      ],
      listSkills: async (binding) => {
        const bindingId = agentBindingIdentity(binding) ?? "unknown";
        return [{ id: `codex:${bindingId}`, name: `${bindingId}-skill`, description: `${bindingId} only` }];
      },
      discoverAllThreads: async (binding) => {
        const bindingId = agentBindingIdentity(binding);
        return completeRuntimeThreadDiscovery(
          bindingId === "personal"
            ? [{ runtimeThreadId: "personal-thread", name: "Personal Session", updatedAt: 1 }]
            : [{ runtimeThreadId: "work-thread", name: "Work Session", updatedAt: 1 }],
        );
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = {
      personal: pluginBinding({}, { outputVisibility: "minimal" }),
      work: pluginBinding({}, { outputVisibility: "full" }),
    };
    config.defaultAgent = "personal";
    config.stateDbPath = store.dbPath;
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const runtimeInteractions = new RuntimeInteractionCoordinator(projection);
    const enqueueWorkTurn = mock(
      async (sessionRef: string, _prompt: string, _media: import("../src/runtime/types").ConnectRuntimeMedia[]) => ({
        turnId: "work-turn",
        sessionRef,
      }),
    );
    const scopedRuntimes: BindingRuntimeHandle[] = [
      {
        agentId: "personal",
        websocketUrl: config.websocketUrl,
        deviceId: "personal-device",
        enqueueClientTurn: async (sessionRef) => ({ turnId: "personal-turn", sessionRef }),
        close: async () => undefined,
      },
      {
        agentId: "work",
        websocketUrl: config.websocketUrl,
        deviceId: "work-device",
        enqueueClientTurn: enqueueWorkTurn,
        close: async () => undefined,
      },
    ];
    const port = 47_895;
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const handle = await startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimeInteractions,
      runtimes: scopedRuntimes,
      assetsPath,
      hostname: "127.0.0.1",
      port,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    openHandles.push(handle);
    if (!fetchHandler) throw new Error("test Client Interface did not expose a request handler");
    const scope = { "x-clawchat-connect-binding-scope": "personal" };
    const globalCatalogResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/session-catalog");
    const globalCatalog = (await globalCatalogResponse.json()) as import("../src/client-contract").SessionCatalogView;
    const globalWorkResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions/WRKREF23");
    const globalWork = (await globalWorkResponse.json()) as import("../src/client-contract").SessionView;
    await store.appendClientViewEvent({
      type: "catalog.changed",
      cursor: 0,
      revision: globalCatalog.revision + 1,
      catalog: { ...globalCatalog, revision: globalCatalog.revision + 1 },
    });
    await store.appendClientViewEvent({
      type: "session.changed",
      cursor: 0,
      sessionRef: globalWork.sessionRef,
      revision: globalWork.revision + 1,
      session: { ...globalWork, revision: globalWork.revision + 1 },
    });

    const bootstrap = await localRequest(fetchHandler, handle.origin, "/client/v1/bootstrap", { headers: scope });
    await expect(bootstrap.json()).resolves.toMatchObject({
      bindings: [{ bindingId: "personal", outputVisibility: "minimal" }],
    });
    const catalog = await localRequest(fetchHandler, handle.origin, "/client/v1/session-catalog", { headers: scope });
    await expect(catalog.json()).resolves.toMatchObject({
      bindings: [{ bindingId: "personal", entries: [{ sessionRef: "PERSNAL2" }] }],
    });
    const workSession = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions/WRKREF23", {
      headers: scope,
    });
    expect(workSession.status).toBe(404);
    const workTranscript = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions/WRKREF23/transcript", {
      headers: scope,
    });
    expect(workTranscript.status).toBe(404);
    const personalSkills = await localRequest(
      fetchHandler,
      handle.origin,
      "/client/v1/sessions/PERSNAL2/slash-suggestions",
      { headers: scope },
    );
    await expect(personalSkills.json()).resolves.toEqual({
      supported: true,
      entries: [{ id: "codex:personal", kind: "skill", name: "personal-skill", description: "personal only" }],
    });
    const crossBindingSkills = await localRequest(
      fetchHandler,
      handle.origin,
      "/client/v1/sessions/WRKREF23/slash-suggestions",
      { headers: scope },
    );
    expect(crossBindingSkills.status).toBe(404);
    const workMutation = await localRequest(fetchHandler, handle.origin, "/client/v1/bindings/work/preferences", {
      method: "PATCH",
      headers: { ...scope, origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "scoped-work-preference", displayName: "Leaked Work" }),
    });
    expect(workMutation.status).toBe(404);
    const workCreation = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { ...scope, origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "scoped-work-session",
        bindingId: "work",
        workspace: { kind: "none" },
        name: "Forbidden",
        mode: null,
        model: null,
        reasoningEffort: null,
      }),
    });
    expect(workCreation.status).toBe(404);
    const workOwnMutation = await localRequest(fetchHandler, handle.origin, "/client/v1/bindings/work/preferences", {
      method: "PATCH",
      headers: {
        "x-clawchat-connect-binding-scope": "work",
        origin: handle.origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "scoped-work-own-preference",
        displayName: "Work Account",
        outputVisibility: "normal",
      }),
    });
    expect(workOwnMutation.status).toBe(200);
    await expect(workOwnMutation.json()).resolves.toMatchObject({ bindingId: "work", outputVisibility: "normal" });
    expect(config.agents.work?.outputVisibility).toBe("normal");
    expect(config.agents.personal?.outputVisibility).toBe("minimal");

    const workSubmissionBody = new FormData();
    workSubmissionBody.append("prompt", "work only");
    workSubmissionBody.append("attachments", new File(["work-secret"], "work.png", { type: "image/png" }));
    const workSubmission = await localRequest(
      fetchHandler,
      handle.origin,
      "/client/v1/sessions/WRKREF23/turn-submissions/work_submission_1",
      {
        method: "POST",
        headers: {
          "x-clawchat-connect-binding-scope": "work",
          origin: handle.origin,
          "sec-fetch-site": "same-origin",
        },
        body: workSubmissionBody,
      },
    );
    if (workSubmission.status !== 202) throw new Error(await workSubmission.text());
    await waitFor(() => enqueueWorkTurn.mock.calls.length >= 1);
    const workAttachmentUrl = enqueueWorkTurn.mock.calls[0]?.[2]?.[0]?.url;
    if (!workAttachmentUrl) throw new Error("work attachment was not staged");
    const crossBindingAttachment = await localRequest(fetchHandler, handle.origin, workAttachmentUrl, {
      headers: scope,
    });
    expect(crossBindingAttachment.status).toBe(404);
    const ownBindingAttachment = await localRequest(fetchHandler, handle.origin, workAttachmentUrl, {
      headers: { "x-clawchat-connect-binding-scope": "work" },
    });
    expect(ownBindingAttachment.status).toBe(200);
    await expect(ownBindingAttachment.text()).resolves.toBe("work-secret");

    const workInteractionResult = runtimeInteractions.request(
      {
        kind: "approval",
        action: "command",
        title: "Work approval",
        description: "work only",
        options: [
          { id: "approve-once", label: "Approve once" },
          { id: "deny", label: "Deny" },
        ],
      },
      { sessionRef: "WRKREF23", turnId: "work-interaction-turn", origin: "client" },
    );
    while ((await store.listPendingRuntimeInteractions("WRKREF23")).length === 0) await Bun.sleep(0);
    const workInteraction = (await store.listPendingRuntimeInteractions("WRKREF23"))[0];
    if (!workInteraction) throw new Error("work interaction was not projected");
    const crossBindingInteraction = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/runtime-interactions/${workInteraction.interactionId}/respond`,
      {
        method: "POST",
        headers: { ...scope, origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "personal_cross_binding_response", optionId: "approve-once" }),
      },
    );
    expect(crossBindingInteraction.status).toBe(404);
    const ownBindingInteraction = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/runtime-interactions/${workInteraction.interactionId}/respond`,
      {
        method: "POST",
        headers: {
          "x-clawchat-connect-binding-scope": "work",
          origin: handle.origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId: "work_own_response", optionId: "approve-once" }),
      },
    );
    expect(ownBindingInteraction.status).toBe(200);
    await expect(workInteractionResult).resolves.toEqual({ kind: "approval", optionId: "approve-once" });

    const eventBatch = await localRequest(fetchHandler, handle.origin, "/client/v1/events/batch?after=0", {
      headers: scope,
    });
    const eventBody = (await eventBatch.json()) as import("../src/client-contract").ClientEventBatchView;
    const eventBindingIds = eventBody.events.flatMap((event) =>
      event.type === "catalog.changed" ? event.catalog.bindings.map((binding) => binding.bindingId) : [],
    );
    expect(eventBindingIds.length).toBeGreaterThan(0);
    expect(eventBindingIds.every((bindingId) => bindingId === "personal")).toBe(true);
    for (let index = 1; index < eventBody.events.length; index += 1) {
      expect(eventBody.events[index]?.previousCursor).toBe(eventBody.events[index - 1]?.cursor);
    }
    expect(
      eventBody.events.some((event) => event.type === "session.changed" && event.session.bindingId === "work"),
    ).toBe(false);
    const workspaceListResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/workspaces", {
      headers: scope,
    });
    const workspaceList = (await workspaceListResponse.json()) as Array<{ bindingId: string; workspaceRef: string }>;
    expect(workspaceList.every(({ bindingId }) => bindingId === "personal")).toBe(true);
    expect(workspaceList).toContainEqual(expect.objectContaining({ workspaceRef: "PERSONAL" }));
  });
  it("retires a Binding dispatcher while rejecting an in-flight lookup and every late submission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-binding-retirement-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect retirement</title>");
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => "RETURE42",
    });
    openStores.push(store);
    const config = defaultConfig();
    config.stateDbPath = store.dbPath;
    config.agents = {
      retiring: pluginBinding({}, { displayName: "Retiring" }),
      unrelated: pluginBinding({}, { displayName: "Unrelated" }),
    };
    config.defaultAgent = "retiring";
    let resolveLookupStarted: () => void = () => undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    let releaseLookup: () => void = () => undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let blockModelLookup = false;
    const registry = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["workspace-write"],
        listModels: async () => {
          if (blockModelLookup) {
            resolveLookupStarted();
            await lookupGate;
          }
          return [
            {
              id: "gpt-default",
              selection: { model: "gpt-default" },
              displayName: "Default model",
              description: "Runtime default",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium"],
              inputModalities: ["text"],
            },
          ];
        },
        start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      }),
    ]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const retiringEnqueue = mock(async (sessionRef: string) => ({ turnId: "retired-turn", sessionRef }));
    const unrelatedEnqueue = mock(async (sessionRef: string) => ({ turnId: "unrelated-turn", sessionRef }));
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const handle = await startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimes: [
        {
          agentId: "retiring",
          websocketUrl: config.websocketUrl,
          deviceId: "device-retiring",
          enqueueClientTurn: retiringEnqueue,
          close: async () => undefined,
        },
        {
          agentId: "unrelated",
          websocketUrl: config.websocketUrl,
          deviceId: "device-unrelated",
          enqueueClientTurn: unrelatedEnqueue,
          close: async () => undefined,
        },
      ],
      assetsPath,
      hostname: "127.0.0.1",
      port: 47_897,
      managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    openHandles.push(handle);
    if (!fetchHandler) throw new Error("test Client Interface did not expose a request handler");
    await store.upsertRuntimeSession({
      chatId: "retiring-chat",
      sessionId: "retiring-session",
      agentId: "retiring",
      runtimeSessionId: null,
      name: "Retiring Session",
      hasMessages: true,
      isCurrent: true,
    });
    const session = await store.getCurrentRuntimeSession("retiring-chat", "retiring");
    if (!session) throw new Error("retiring test session was not created");
    const refreshedCatalog = await localRequest(fetchHandler, handle.origin, "/client/v1/session-catalog?refresh=1");
    expect(refreshedCatalog.status).toBe(200);
    blockModelLookup = true;
    const body = new FormData();
    body.append("prompt", "must not dispatch");
    const inFlight = localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/retire_in_flight`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body,
      },
    );
    const completedBeforeLookup = await Promise.race([lookupStarted.then(() => null), inFlight]);
    if (completedBeforeLookup) {
      throw new Error(`submission completed before lookup gate: ${completedBeforeLookup.status}`);
    }
    let retirementSettled = false;
    const retirement = handle.retireBindings(["retiring"]).finally(() => {
      retirementSettled = true;
    });
    await Promise.resolve();
    expect(retirementSettled).toBe(false);
    releaseLookup();
    await retirement;
    const rejected = await inFlight;
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "submission-cancelled" } });
    expect(retiringEnqueue).not.toHaveBeenCalled();

    const lateBody = new FormData();
    lateBody.append("prompt", "still must not dispatch");
    const late = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/retire_late`,
      {
        method: "POST",
        headers: { origin: handle.origin },
        body: lateBody,
      },
    );
    expect(late.status).toBe(503);
    await expect(late.json()).resolves.toMatchObject({ error: { code: "runtime-offline", retryable: true } });
    expect(retiringEnqueue).not.toHaveBeenCalled();
    expect(unrelatedEnqueue).not.toHaveBeenCalled();
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for asynchronous Client Interface work");
}

async function localRequest(
  fetchHandler: (request: Request) => Response | Promise<Response>,
  origin: string,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(origin).host);
  return await fetchHandler(new Request(new URL(input, origin), { ...init, headers }));
}
