import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingRuntimeHandle } from "../src/binding-runtime";
import { type ClientInterfaceHandle, startClientInterface } from "../src/client-interface/server";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { RuntimeInteractionCoordinator } from "../src/runtime/runtime-interaction-coordinator";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";
import { type ConnectStateStore, createStateStore } from "../src/state";

const openHandles: ClientInterfaceHandle[] = [];
const openStores: ConnectStateStore[] = [];

afterEach(async () => {
  await Promise.allSettled(openHandles.splice(0).map(async (handle) => await handle.stop()));
  await Promise.allSettled(openStores.splice(0).map(async (store) => await store.close()));
});

describe("Connect Client Interface", () => {
  it("serves direct loopback snapshots and local turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-interface-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect test</title>");
    const sessionRefs = ["ABCDEFGH", "BCDEFGHJ"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => sessionRefs.shift() ?? "CDEFGHJK",
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
    const session = await store.getCurrentRuntimeSession("chat-1", "codex");
    if (!session) throw new Error("test session was not created");
    let isArchived = false;
    let isDeleted = false;
    const lifecycleCalls: string[] = [];
    const summary = { runtimeThreadId: "thread-1", name: "First session", updatedAt: 1 };
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels: async () => [
        {
          id: "gpt-default",
          displayName: "Default model",
          description: "Runtime default",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium", "high"],
          inputModalities: ["text", "image"],
        },
        {
          id: "gpt-deep",
          displayName: "Deep model",
          description: "Long tasks",
          isDefault: false,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["high", "xhigh"],
          inputModalities: ["text", "image"],
        },
      ],
      discoverAllThreads: async () => (!isArchived && !isDeleted ? [summary] : []),
      discoverArchivedThreads: async () => (isArchived && !isDeleted ? [{ ...summary, isArchived: true }] : []),
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
      readTranscript: async () => [
        { id: "user-1", kind: "user", text: "hello", state: "complete" },
        { id: "agent-1", kind: "assistant", text: "world", state: "complete" },
        {
          id: "subagent-1",
          kind: "subagent",
          text: "Scout · researcher",
          state: "complete",
          data: { title: "Scout", role: "researcher", activityKind: "started" },
          children: [
            { id: "child-user", kind: "user", text: "investigate", state: "complete" },
            { id: "child-agent", kind: "assistant", text: "found it", state: "complete" },
          ],
        },
      ],
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const registry = new RuntimeAdapterRegistry([adapter]);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    config.defaultAgent = "codex";
    config.stateDbPath = store.dbPath;
    const enqueueClientTurn = mock(async (sessionRef: string) => ({ turnId: "turn-123", sessionRef }));
    const runtime: BindingRuntimeHandle = {
      agentId: "codex",
      websocketUrl: config.websocketUrl,
      deviceId: "device-1",
      enqueueClientTurn,
      close: async () => undefined,
    };
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const runtimeInteractions = new RuntimeInteractionCoordinator(projection);
    const port = 47_891;
    config.clientPort = port;
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const handle = await startClientInterface({
      config,
      configPath: join(directory, "config.json"),
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      runtimeInteractions,
      runtimes: [runtime],
      assetsPath,
      port,
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
    expect(contentSecurityPolicy).toContain("script-src 'self'; script-src-attr 'none'");
    expect(contentSecurityPolicy).toContain("style-src-elem 'self'; style-src-attr 'unsafe-inline'");
    expect(contentSecurityPolicy).not.toContain("script-src 'self' 'unsafe-inline'");
    const bootstrap = await localRequest(fetchHandler, handle.origin, "/client/v1/bootstrap");
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      apiVersion: 1,
      bindings: [{ bindingId: "codex", displayName: "Codex", clawChatUserId: "usr_agent_codex" }],
      capabilities: { localTurns: true, runtimeInteractions: true },
    });
    const invalidBindingModel = await localRequest(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/codex/preferences",
      {
        method: "PATCH",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "binding_invalid_model_request",
          model: "missing-model",
          modelReasoningEffort: "high",
        }),
      },
    );
    expect(invalidBindingModel.status).toBe(400);
    expect(config.agents.codex).toMatchObject({ kind: "codex", displayName: "Codex" });
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
      effectiveModel: "gpt-default",
      effectiveReasoningEffort: "medium",
      modelSource: "runtime",
      modelAvailable: true,
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
          model: "missing-model",
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
        body: JSON.stringify({ requestId: "model_request", model: "gpt-deep", reasoningEffort: "xhigh" }),
      },
    );
    expect(modelPreference.status).toBe(200);
    await expect(modelPreference.json()).resolves.toMatchObject({
      sessionRef: session.sessionRef,
      model: "gpt-deep",
      reasoningEffort: "xhigh",
      effectiveModel: "gpt-deep",
      modelSource: "session",
    });
    await expect(store.getRuntimeSessionByRef(session.sessionRef)).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
    });
    const projectRoot = join(directory, "project-root");
    await mkdir(projectRoot);
    const registeredProject = await localRequest(fetchHandler, handle.origin, "/client/v1/projects", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "project_add_request",
        name: "connect",
        rootPath: projectRoot,
        additionalDirectories: [],
      }),
    });
    expect(registeredProject.status).toBe(201);
    const registeredProjectView = (await registeredProject.json()) as { projectId: string };
    const projects = await localRequest(fetchHandler, handle.origin, "/client/v1/projects");
    const projectViews = (await projects.json()) as Array<{ projectId: string; name: string; rootPath: string }>;
    expect(projectViews).toHaveLength(1);
    expect(projectViews[0]).toMatchObject({ projectId: registeredProjectView.projectId, name: "connect" });
    expect(projectViews[0]?.rootPath).toBe(await realpath(projectRoot));
    const removedProject = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/projects/${registeredProjectView.projectId}`,
      {
        method: "DELETE",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "project_remove_request" }),
      },
    );
    expect(removedProject.status).toBe(200);
    await expect(removedProject.json()).resolves.toEqual({
      projectId: registeredProjectView.projectId,
      removed: true,
    });
    const sessionProjectRoot = join(directory, "session-project-root");
    await mkdir(sessionProjectRoot);
    const sessionProjectResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/projects", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "session_project_add_request",
        name: "session-project",
        rootPath: sessionProjectRoot,
        additionalDirectories: [],
      }),
    });
    const sessionProject = (await sessionProjectResponse.json()) as { projectId: string };
    const sessionsBeforeInvalidCreate = await store.listAllRuntimeSessions();
    const invalidCreatedSession = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "session_invalid_create_request",
        prompt: "This must not run",
        bindingId: "codex",
        projectId: sessionProject.projectId,
        name: "Invalid model",
        mode: "workspace-write",
        model: "missing-model",
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
        projectId: sessionProject.projectId,
        name: "Planned from Client",
        mode: "workspace-write",
        model: "gpt-deep",
        reasoningEffort: "xhigh",
      }),
    });
    expect(createdSession.status).toBe(201);
    const createdSessionView = (await createdSession.json()) as {
      sessionRef: string;
      projectId: string;
      mode: string;
      model: string;
      reasoningEffort: string;
      runtimeThreadAvailable: boolean;
    };
    expect(createdSessionView).toMatchObject({
      projectId: sessionProject.projectId,
      mode: "workspace-write",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
      runtimeThreadAvailable: false,
    });
    await expect(store.getRuntimeSessionByRef(createdSessionView.sessionRef)).resolves.toMatchObject({
      projectId: sessionProject.projectId,
      mode: "workspace-write",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
      runtimeSessionId: null,
    });
    expect(enqueueClientTurn).not.toHaveBeenCalled();
    const transcript = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/transcript`,
    );
    expect(transcript.status).toBe(200);
    await expect(transcript.json()).resolves.toMatchObject({
      sessionRef: session.sessionRef,
      blocks: [
        { type: "message", role: "user", markdown: "hello" },
        { type: "message", role: "assistant", markdown: "world" },
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

    const eventCursor = await store.getClientEventCursor();
    await projection.appendUserMessage({
      sessionRef: session.sessionRef,
      text: "from ClawChat",
      origin: "clawchat",
      author: "usr_opaque",
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
    await expect(eventBatch.json()).resolves.toMatchObject({
      events: [
        {
          type: "transcript.block-upserted",
          sessionRef: session.sessionRef,
          block: {
            type: "message",
            origin: "clawchat",
            markdown: "from ClawChat",
            media: [
              {
                kind: "image",
                url: "https://media.clawling.chat/media/example.jpg",
                name: "example.jpg",
              },
            ],
          },
        },
      ],
    });

    const turn = await localRequest(fetchHandler, handle.origin, `/client/v1/sessions/${session.sessionRef}/turns`, {
      method: "POST",
      headers: {
        origin: handle.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "request_123", prompt: "from web" }),
    });
    expect(turn.status).toBe(202);
    await expect(turn.json()).resolves.toEqual({ accepted: true, turnId: "turn-123", sessionRef: session.sessionRef });
    expect(enqueueClientTurn).toHaveBeenCalledWith(session.sessionRef, "from web");

    const replayedTurn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turns`,
      {
        method: "POST",
        headers: {
          origin: handle.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId: "request_123", prompt: "from web" }),
      },
    );
    expect(replayedTurn.status).toBe(202);
    expect(enqueueClientTurn).toHaveBeenCalledTimes(1);

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
      `/client/v1/sessions/${session.sessionRef}/turns`,
      {
        method: "POST",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "request_blocked_by_approval", prompt: "must wait" }),
      },
    );
    expect(blockedTurn.status).toBe(409);
    await expect(blockedTurn.json()).resolves.toMatchObject({
      error: { code: "runtime-interaction-pending" },
    });
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
      `/client/v1/sessions/${session.sessionRef}/turns`,
      {
        method: "POST",
        headers: { origin: "http://evil.invalid" },
        body: "{}",
      },
    );
    expect(rejected.status).toBe(403);

    const livewareOrigin = "https://app-connect-test.apps.clawling.io";
    await store.setLivewareExposure({
      ownerUserId: "owner-1",
      localAgentId: "codex",
      appId: "app-connect-test",
      publicUrl: livewareOrigin,
      accessPolicy: "private",
    });
    const livewareMutation = await localRequest(fetchHandler, handle.origin, "/client/v1/not-found", {
      method: "POST",
      headers: { origin: livewareOrigin, "sec-fetch-site": "same-origin" },
    });
    expect(livewareMutation.status).toBe(404);

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
    await expect(store.getSessionRefTarget(session.sessionRef)).resolves.toBeNull();
  });

  it("rolls back a Session when its response view cannot be built", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-create-retry-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect test</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    openStores.push(store);
    const config = defaultConfig();
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    config.defaultAgent = "codex";
    let catalogUnavailable = true;
    const registry = new RuntimeAdapterRegistry([
      {
        kind: "codex",
        modes: ["workspace-write"],
        listModels: async () => {
          if (catalogUnavailable) throw new Error("catalog temporarily unavailable");
          return [
            {
              id: "gpt-default",
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
      },
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
      port,
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
      projectId: null,
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

    catalogUnavailable = false;
    const retried = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(retried.status).toBe(201);
    expect(enqueueClientTurn).not.toHaveBeenCalled();
    await expect(store.listAllRuntimeSessions()).resolves.toHaveLength(1);
  });

  it("serves documents directly and rejects invalid Host headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-auth-"));
    const assetsPath = join(directory, "assets");
    await mkdir(assetsPath);
    await Bun.write(join(assetsPath, "index.html"), "<!doctype html><title>Connect test</title>");
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    openStores.push(store);
    const config = defaultConfig();
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
      port,
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
    config.clientHost = "0.0.0.0";
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
      port,
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
});

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
