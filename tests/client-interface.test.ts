import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingRuntimeHandle } from "../src/binding-runtime";
import { type ClientInterfaceHandle, startClientInterface } from "../src/client-interface/server";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { ProjectCatalog } from "../src/projects";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { RuntimeInteractionCoordinator } from "../src/runtime/runtime-interaction-coordinator";
import type { ConnectRuntimeAdapter, RuntimeModelOption } from "../src/runtime/types";
import { type ConnectStateStore, createStateStore } from "../src/state";
import { fixedRuntimeAdapter } from "./runtime-adapter-fixture";

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
    const listModels = mock(
      async (
        binding: Parameters<NonNullable<ConnectRuntimeAdapter["listModels"]>>[0],
      ): Promise<RuntimeModelOption[]> => {
        runtimeBindingIds.add(binding.env?.CLAWCHAT_CONNECT_AGENT_ID);
        return [
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
        runtimeBindingIds.add(binding.env?.CLAWCHAT_CONNECT_AGENT_ID);
        return [];
      },
    );
    const summary = { runtimeThreadId: "thread-1", name: "First session", updatedAt: 1 };
    const discoveredSummary = {
      runtimeThreadId: "thread-discovered",
      name: "Discovered workspace session",
      updatedAt: 2,
      workingDirectory: discoveredWorkspaceRoot,
    };
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels,
      listSessionOptions,
      listSkills: async (binding) => {
        runtimeBindingIds.add(binding.env?.CLAWCHAT_CONNECT_AGENT_ID);
        return [
          {
            id: "codex:grill-with-docs",
            name: "grill-with-docs",
            description: "Challenge a proposal against primary documentation",
          },
        ];
      },
      listCommands: async (binding) => {
        runtimeBindingIds.add(binding.env?.CLAWCHAT_CONNECT_AGENT_ID);
        return [
          { id: "codex-command:compact", name: "compact", description: "Compact the Session" },
          { id: "codex-command:grill-with-docs", name: "grill-with-docs", description: "Runtime command" },
        ];
      },
      discoverAllThreads: async () => (!isArchived && !isDeleted ? [summary, discoveredSummary] : [discoveredSummary]),
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
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
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
      bindings: [
        {
          bindingId: "codex",
          displayName: "Codex",
          clawChatUserId: "usr_agent_codex",
          runtimeKind: "codex",
          runtimeProfile: null,
        },
      ],
      runtimeAdapters: [
        { kind: "codex", profiles: [] },
        { kind: "opencode", profiles: [] },
        {
          kind: "workbuddy",
          profiles: [
            { id: "workbuddy-ai", applicationVersion: "5.2.7" },
            { id: "workbuddy-cn", applicationVersion: "5.3.8" },
          ],
        },
      ],
      capabilities: { localTurns: true, runtimeInteractions: true },
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
    const customNamedProject = await localRequest(fetchHandler, handle.origin, "/client/v1/projects", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "project_custom_name_request",
        name: "connect-qa",
        rootPath: projectRoot,
        additionalDirectories: [],
      }),
    });
    expect(customNamedProject.status).toBe(400);
    const registeredProject = await localRequest(fetchHandler, handle.origin, "/client/v1/projects", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "project_add_request",
        rootPath: projectRoot,
        additionalDirectories: [],
      }),
    });
    expect(registeredProject.status).toBe(201);
    const registeredProjectView = (await registeredProject.json()) as { projectId: string; workspaceId: string };
    const projects = await localRequest(fetchHandler, handle.origin, "/client/v1/projects");
    const projectViews = (await projects.json()) as Array<{
      projectId: string;
      workspaceId: string;
      name: string;
      rootPath: string;
    }>;
    expect(projectViews).toHaveLength(2);
    expect(projectViews).toContainEqual(
      expect.objectContaining({
        projectId: registeredProjectView.projectId,
        workspaceId: registeredProjectView.workspaceId,
        name: "project-root",
        rootPath: await realpath(projectRoot),
      }),
    );
    const removedProject = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/projects/${registeredProjectView.workspaceId}`,
      {
        method: "DELETE",
        headers: { origin: handle.origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "project_remove_request" }),
      },
    );
    expect(removedProject.status).toBe(200);
    await expect(removedProject.json()).resolves.toEqual({
      workspaceId: registeredProjectView.workspaceId,
      removed: true,
    });
    const sessionProjectRoot = join(directory, "session-project-root");
    await mkdir(sessionProjectRoot);
    const sessionProjectResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/projects", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "session_project_add_request",
        rootPath: sessionProjectRoot,
        additionalDirectories: [],
      }),
    });
    const sessionProject = (await sessionProjectResponse.json()) as { projectId: string; workspaceId: string };
    const sessionsBeforeInvalidCreate = await store.listAllRuntimeSessions();
    const invalidCreatedSession = await localRequest(fetchHandler, handle.origin, "/client/v1/sessions", {
      method: "POST",
      headers: { origin: handle.origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "session_invalid_create_request",
        prompt: "This must not run",
        bindingId: "codex",
        workspaceId: sessionProject.workspaceId,
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
        workspaceId: sessionProject.workspaceId,
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
      projectId: sessionProject.projectId,
      mode: "workspace-write",
      model: "gpt-deep",
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
      projectId: sessionProject.projectId,
      mode: "workspace-write",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
      runtimeSessionId: null,
    });
    const catalogResponse = await localRequest(fetchHandler, handle.origin, "/client/v1/session-catalog?refresh=1");
    const catalogView = (await catalogResponse.json()) as {
      bindings: Array<{
        entries: Array<{ sessionRef: string; workspaceId: string | null; workspaceName: string | null }>;
      }>;
    };
    const discoveredWorkspace = catalogView.bindings[0]?.entries.find(
      (entry) => entry.workspaceName === "discovered-workspace",
    );
    expect(discoveredWorkspace?.workspaceId).toBeTruthy();
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
        workspaceId: discoveredWorkspace?.workspaceId,
        name: "Created in discovered workspace",
        mode: "workspace-write",
        model: null,
        reasoningEffort: null,
      }),
    });
    expect(workspaceSession.status).toBe(201);
    const workspaceSessionView = (await workspaceSession.json()) as { sessionRef: string; projectId: string };
    const materializedWorkspaceProject = await store.getProject(workspaceSessionView.projectId);
    expect(materializedWorkspaceProject?.rootPath).toBe(await realpath(discoveredWorkspaceRoot));
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

    const runtimeWorkspace = await new ProjectCatalog(store).resolveWorkspace(session);
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
    await expect(turn.json()).resolves.toEqual({ accepted: true, turnId: "turn-123", sessionRef: session.sessionRef });
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
    expect(enqueueClientTurn).toHaveBeenLastCalledWith(
      session.sessionRef,
      "/not-a-skill keep this as ordinary text",
      [],
      null,
      expect.any(AbortSignal),
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
    );
    expect(enqueueClientTurn).toHaveBeenCalledTimes(3);

    const acceptedOutcome = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_123`,
    );
    expect(acceptedOutcome.status).toBe(202);
    await expect(acceptedOutcome.json()).resolves.toMatchObject({ accepted: true, turnId: "turn-123" });

    const acceptedCancelRace = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_123`,
      { method: "DELETE", headers: { origin: handle.origin } },
    );
    expect(acceptedCancelRace.status).toBe(202);
    await expect(acceptedCancelRace.json()).resolves.toMatchObject({ accepted: true, turnId: "turn-123" });

    const cancelledBeforeUpload = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_cancelled`,
      { method: "DELETE", headers: { origin: handle.origin } },
    );
    expect(cancelledBeforeUpload.status).toBe(200);
    const cancelledBody = new FormData();
    cancelledBody.append("prompt", "must not enter the queue");
    const cancelledTurn = await localRequest(
      fetchHandler,
      handle.origin,
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/request_cancelled`,
      { method: "POST", headers: { origin: handle.origin }, body: cancelledBody },
    );
    expect(cancelledTurn.status).toBe(409);
    await expect(cancelledTurn.json()).resolves.toMatchObject({ error: { code: "submission-cancelled" } });
    expect(enqueueClientTurn).toHaveBeenCalledTimes(3);

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
    expect(blockedTurn.status).toBe(409);
    await expect(blockedTurn.json()).resolves.toMatchObject({
      error: { code: "runtime-interaction-pending" },
    });
    const stagingEntries = await readdir(join(directory, "turn-submissions"));
    expect(stagingEntries.some((entry) => entry.startsWith("request_blocked_by_approval-"))).toBe(false);
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
    expect([...runtimeBindingIds]).toEqual(["codex"]);
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
    config.stateDbPath = store.dbPath;
    config.agents = { codex: { kind: "codex", displayName: "Codex" } };
    config.defaultAgent = "codex";
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
      workspaceId: null,
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
    config.stateDbPath = store.dbPath;
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

  it("restricts a Binding-scoped Client gateway to its Agent Binding while sharing Projects", async () => {
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
    await store.insertProject({ projectId: "shared-project", name: "Shared Project", rootPath: directory });
    await store.setLivewareExposure({
      localAgentId: "personal",
      ownerUserId: "owner-personal",
      appId: "app-personal",
      publicUrl: "https://personal.apps.example",
      accessPolicy: "private",
    });
    await store.setLivewareExposure({
      localAgentId: "work",
      ownerUserId: "owner-work",
      appId: "app-work",
      publicUrl: "https://work.apps.example",
      accessPolicy: "private",
    });
    await store.upsertRuntimeSession({
      chatId: "personal-chat",
      sessionId: "personal-session",
      agentId: "personal",
      runtimeSessionId: "personal-thread",
      name: "Personal Session",
      hasMessages: true,
    });
    await store.upsertRuntimeSession({
      chatId: "work-chat",
      sessionId: "work-session",
      agentId: "work",
      runtimeSessionId: "work-thread",
      name: "Work Session",
      hasMessages: true,
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels: async () => [
        {
          id: "scoped-model",
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
        const bindingId = binding.env?.CLAWCHAT_CONNECT_AGENT_ID ?? "unknown";
        return [{ id: `codex:${bindingId}`, name: `${bindingId}-skill`, description: `${bindingId} only` }];
      },
      discoverAllThreads: async (binding) => {
        const bindingId = binding.env?.CLAWCHAT_CONNECT_AGENT_ID;
        return bindingId === "personal"
          ? [{ runtimeThreadId: "personal-thread", name: "Personal Session", updatedAt: 1 }]
          : [{ runtimeThreadId: "work-thread", name: "Work Session", updatedAt: 1 }];
      },
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
    };
    const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const config = defaultConfig();
    config.agents = {
      personal: { kind: "codex", outputVisibility: "minimal" },
      work: { kind: "codex", outputVisibility: "full" },
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
      port,
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
        workspaceId: null,
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
        origin: "https://work.apps.example",
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
          origin: "https://work.apps.example",
          "sec-fetch-site": "same-origin",
        },
        body: workSubmissionBody,
      },
    );
    if (workSubmission.status !== 202) throw new Error(await workSubmission.text());
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
          origin: "https://work.apps.example",
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
    const projectList = await localRequest(fetchHandler, handle.origin, "/client/v1/projects", { headers: scope });
    await expect(projectList.json()).resolves.toEqual([expect.objectContaining({ projectId: "shared-project" })]);
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
