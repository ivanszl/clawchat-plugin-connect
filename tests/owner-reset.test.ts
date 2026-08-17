import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConnect } from "../src/account/activation";
import { OWNER_RESET_CONFIRMATION_PHRASE, resetInstallationOwner } from "../src/account/owner-reset";
import { defaultConfig, loadConfig, saveConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectBindingLivewarePublicationStateStore } from "../src/plugin/official/liveware-publication-state";
import { retireOfficialLivewarePublications } from "../src/plugin/official/liveware-retirement";
import { pluginInstallationPaths } from "../src/plugin/store";
import { runConnectCli } from "../src/service/cli";
import type {
  ClawChatLivewarePort,
  LivewareApp,
  LivewareControlPlanePort,
  LivewareControlSession,
} from "../src/service/liveware-control";
import type { ActivationCredentials } from "../src/types";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { pluginBinding } from "./runtime-adapter-fixture";

const PLUGIN_ID = "test.owner-reset-preserved";

describe("Installation Owner Reset", () => {
  it("requires the exact phrase and never calls the reset mutation on mismatch", async () => {
    const reset = mock(async () => ({ ownerUserId: "owner", removedBindings: [], configPath: "/config.json" }));
    const output = captureIo();

    await expect(
      runConnectCli(["owner", "reset"], {
        ...output.deps,
        readStdin: async () => "reset installation owner",
        resetInstallationOwner: reset,
      }),
    ).resolves.toBe(1);

    expect(output.stdout.join("")).toContain("Owner Reset will permanently remove:");
    expect(output.stdout.join("")).toContain("installed Plugins, Plugin lock state");
    expect(output.stdout.join("")).toContain(OWNER_RESET_CONFIRMATION_PHRASE);
    expect(output.stderr.join("")).toContain("confirmation phrase did not match");
    expect(reset).not.toHaveBeenCalled();
  });

  it("runs the real command transaction, cleans external ports before credentials, and preserves installation assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-owner-reset-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const workspaceRoot = join(directory, "global-project");
    const nativeRoot = join(directory, "native-runtime");
    const codingAgentRoot = join(directory, "coding-agent-install");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(nativeRoot, { recursive: true });
    await mkdir(codingAgentRoot, { recursive: true });
    await Bun.write(join(workspaceRoot, "workspace.txt"), "preserve project workspace");
    await Bun.write(join(nativeRoot, "thread-and-transcript.json"), '{"thread":"native-1","transcript":["native"]}');
    await Bun.write(join(codingAgentRoot, "runtime"), "installed coding agent");

    let config = upsertAgentBinding(defaultConfig(), "personal", pluginBinding());
    config = upsertAgentBinding(config, "work", pluginBinding());
    config.stateDbPath = stateDbPath;
    config.clientPort = 49_321;
    config.outputVisibility = "full";
    await saveConfig(config, configPath);
    const pluginPaths = pluginInstallationPaths(configPath);
    const activeArtifact = join(pluginPaths.store, "owner-reset-preserved", "runtime.mjs");
    await mkdir(join(pluginPaths.store, "owner-reset-preserved"), { recursive: true });
    await Bun.write(activeArtifact, "export default 'preserved';");
    await Bun.write(
      pluginPaths.lockfile,
      JSON.stringify({
        format: "clawchat-connect-plugin-lock-v1",
        plugins: {
          [PLUGIN_ID]: {
            activeArtifact,
            installationConfiguration: { retained: true },
          },
        },
      }),
    );
    const lockBefore = await readFile(pluginPaths.lockfile, "utf8");

    const store = createStateStore({ dbPath: stateDbPath });
    const publicationState = new ConnectBindingLivewarePublicationStateStore(store);
    await store.setDeviceId("device-owner-reset");
    const personal = activation("personal", "token-personal");
    const work = activation("work", "token-work");
    await expect(store.commitActivationForInstallationOwner(personal)).resolves.toBe("established");
    await expect(store.commitActivationForInstallationOwner(work)).resolves.toBe("existing");
    await publicationState.compareAndSwap("personal", null, publication("personal", "app-personal"));
    await publicationState.compareAndSwap("work", null, publication("work", "app-work"));
    const project = await store.insertWorkspace({
      bindingId: "personal",
      workspaceRef: "GLOBAL01",
      runtimeIdentityKey: null,
      source: "runtime",
      name: "Global",
      rootPath: workspaceRoot,
      selectable: true,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-personal",
      sessionId: "session-personal",
      agentId: "personal",
      runtimeSessionId: "native-thread-personal",
      workspaceRef: project.workspaceRef,
      isCurrent: true,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-work",
      sessionId: "session-work",
      agentId: "work",
      runtimeSessionId: "native-thread-work",
      workspaceRef: null,
      isCurrent: true,
    });
    const sessions = await store.listAllRuntimeSessions();
    const workSession = sessions.find((session) => session.agentId === "work");
    if (!workSession) throw new Error("expected work Session");
    await store.setOutputVisibility("work", "chat-work", "minimal");
    await store.replaceGroupSettingsSnapshot("work", [
      {
        conversationId: "chat-work",
        muted: false,
        replyMode: "mention",
        batchDelaySeconds: 1,
        version: 1,
      },
    ]);
    await store.submitToolRequest({
      requestId: "tool-owner-reset",
      bindingId: "work",
      toolName: "liveware_app_list",
      normalizedInput: {},
      timeoutMs: 10_000,
      provenance: { sessionRef: workSession.sessionRef, turnId: "turn-owner-reset", origin: "runtime" },
    });
    await store.upsertTranscriptBlock(workSession.sessionRef, {
      id: "runtime-interaction:interaction-owner-reset",
      type: "runtime-interaction",
      origin: "runtime",
      state: "pending",
      plainText: "Approve",
      interactionId: "interaction-owner-reset",
      interactionType: "approval",
      action: "command",
      title: "Approve",
      description: "Proceed?",
      responseState: "pending",
      options: [],
      questions: [],
      command: "echo reset",
      cwd: null,
      files: [],
      autoResolutionAt: null,
      resolvedOptionId: null,
      resolvedBy: null,
    });

    const workspaces = new WorkspaceCatalog(store);
    const transientWorkspace = await workspaces.resolveWorkspace(workSession);
    await Bun.write(join(transientWorkspace.workingDirectory, "transient.txt"), "preserve transient workspace");
    const stagingRoot = join(directory, "turn-submissions", "submission-owner-reset");
    await mkdir(stagingRoot, { recursive: true });
    await Bun.write(
      join(stagingRoot, "manifest.json"),
      JSON.stringify({ sessionRef: workSession.sessionRef, attachments: [] }),
    );

    const actions: string[] = [];
    const external = fakeLivewarePorts(actions);
    const output = captureIo();
    await expect(
      runConnectCli(["owner", "reset", "--yes-reset-owner", "--config", configPath], {
        ...output.deps,
        resetInstallationOwner: async (options) =>
          await resetInstallationOwner(options, {
            store,
            getServiceStatus: async () => ({ running: true }),
            stopService: async () => {
              actions.push("connections:stop");
            },
            startService: async () => {
              actions.push("connections:restart");
            },
            retireLivewarePublications: async (bindingIds) =>
              await retireOfficialLivewarePublications({
                bindingIds,
                configPath,
                clawChatBaseUrl: "https://clawchat.test",
                stateStore: store,
                dependencies: external,
              }),
          }),
      }),
    ).resolves.toBe(0);

    expect(actions).toEqual([
      "connections:stop",
      "registration:remove:personal:app-personal:token-personal",
      "control:connect:token-personal",
      "app:delete:app-personal",
      "registration:remove:work:app-work:token-work",
      "control:connect:token-work",
      "app:delete:app-work",
    ]);
    expect(output.stdout.join("")).toContain("Owner Reset will retain:");
    expect(output.stdout.join("")).toContain("Connect is unowned");
    await expect(store.getInstallationOwner()).resolves.toBeNull();
    await expect(store.listActivations()).resolves.toEqual([]);
    await expect(store.listAllRuntimeSessions()).resolves.toEqual([]);
    await expect(store.getToolRequest("tool-owner-reset")).resolves.toBeNull();
    await expect(store.getOutputVisibility("work", "chat-work")).resolves.toBeNull();
    await expect(publicationState.read("personal")).resolves.toBeNull();
    await expect(publicationState.read("work")).resolves.toBeNull();
    await expect(store.listWorkspaces()).resolves.toEqual([]);
    await expect(readdir(join(directory, "turn-submissions"))).resolves.toEqual([]);
    await expect(Bun.file(join(transientWorkspace.workingDirectory, "transient.txt")).text()).resolves.toBe(
      "preserve transient workspace",
    );

    const resetConfig = await loadConfig(configPath);
    expect(resetConfig.agents).toEqual({});
    expect(resetConfig.defaultAgent).toBeNull();
    expect(resetConfig.clientPort).toBe(49_321);
    expect(resetConfig.outputVisibility).toBe("full");
    expect(await readFile(join(workspaceRoot, "workspace.txt"), "utf8")).toBe("preserve project workspace");
    expect(await readFile(join(nativeRoot, "thread-and-transcript.json"), "utf8")).toContain("native-1");
    expect(await readFile(join(codingAgentRoot, "runtime"), "utf8")).toBe("installed coding agent");
    expect(await readFile(pluginPaths.lockfile, "utf8")).toBe(lockBefore);
    await expect(Bun.file(activeArtifact).exists()).resolves.toBe(true);
    expect(await readFile(activeArtifact, "utf8")).toBe("export default 'preserved';");

    const nextConfig = upsertAgentBinding(resetConfig, "next", pluginBinding());
    const failingFetch = mock(async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? json({
            code: 0,
            data: {
              access_token: "token-next",
              agent: { id: "agent-next", user_id: "agent-user-next", owner_id: "owner-next" },
            },
          })
        : json({ code: 500, msg: "profile unavailable" }),
    ) as unknown as typeof fetch;
    await expect(
      activateConnect({ agentId: "next", code: "NEXTOWNER", config: nextConfig, store, fetchImpl: failingFetch }),
    ).rejects.toThrow("Installation Owner were preserved");
    await expect(store.getInstallationOwner()).resolves.toBeNull();
    await expect(store.getActivation("next")).resolves.toBeNull();
    await store.close();
  });
  it("rejects ambiguous legacy ownership and resets Binding-scoped catalogs without deleting Workspace files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-ambiguous-owner-reset-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const workspaceRoot = join(directory, "retained-project");
    await mkdir(workspaceRoot, { recursive: true });
    let config = upsertAgentBinding(defaultConfig(), "personal", pluginBinding());
    config = upsertAgentBinding(config, "work", pluginBinding());
    config.stateDbPath = stateDbPath;
    await saveConfig(config, configPath);

    const pluginPaths = pluginInstallationPaths(configPath);
    const activeArtifact = join(pluginPaths.store, "ambiguous-owner-retained", "runtime.mjs");
    await mkdir(join(pluginPaths.store, "ambiguous-owner-retained"), { recursive: true });
    await Bun.write(activeArtifact, "export default 'retained';");
    await Bun.write(
      pluginPaths.lockfile,
      JSON.stringify({
        format: "clawchat-connect-plugin-lock-v1",
        plugins: {
          [PLUGIN_ID]: {
            activeArtifact,
            installationConfiguration: { retained: true },
          },
        },
      }),
    );
    const lockBefore = await readFile(pluginPaths.lockfile, "utf8");

    const bootstrap = createStateStore({ dbPath: stateDbPath });
    await bootstrap.insertWorkspace({
      bindingId: "personal",
      workspaceRef: "RETAIN01",
      runtimeIdentityKey: null,
      source: "runtime",
      name: "Retained",
      rootPath: workspaceRoot,
      selectable: true,
    });
    await bootstrap.close();

    const legacy = new Database(stateDbPath);
    legacy.exec(`
      INSERT INTO activations VALUES (
        'clawchat-connect', 'personal', 'token-personal', NULL, 'server-personal',
        'user-personal', 'owner-personal', 'conversation-personal', 1, 1
      );
      INSERT INTO activations VALUES (
        'clawchat-connect', 'work', 'token-work', NULL, 'server-work',
        'user-work', 'owner-work', 'conversation-work', 2, 2
      );
      DELETE FROM installation_owner;
    `);
    legacy.close();

    const store = createStateStore({ dbPath: stateDbPath });
    await expect(store.initialize()).rejects.toThrow(/multiple owners.*owner reset/iu);

    const retired: string[] = [];
    const result = await resetInstallationOwner(
      { configPath },
      {
        store,
        getServiceStatus: async () => ({ running: false }),
        retireLivewarePublications: async (bindingIds) => {
          retired.push(...bindingIds);
        },
        purgeStagedSessions: async () => undefined,
        purgeBindingCatalog: async () => undefined,
      },
    );

    expect(result.ownerUserId).toBeNull();
    expect(retired).toEqual(["personal", "work"]);
    await expect(store.getInstallationOwner()).resolves.toBeNull();
    await expect(store.listActivations()).resolves.toEqual([]);
    await expect(new ConnectBindingLivewarePublicationStateStore(store).read("personal")).resolves.toBeNull();
    await expect(store.listWorkspaces()).resolves.toEqual([]);
    expect(await readFile(pluginPaths.lockfile, "utf8")).toBe(lockBefore);
    expect(await Bun.file(activeArtifact).exists()).toBe(true);
    await store.close();
  });
});

function activation(localAgentId: string, accessToken: string): ActivationCredentials {
  return {
    localAgentId,
    accessToken,
    refreshToken: null,
    serverAgentId: `server-${localAgentId}`,
    userId: `agent-user-${localAgentId}`,
    ownerUserId: "installation-owner",
    conversationId: `conversation-${localAgentId}`,
  };
}

function publication(bindingId: string, appId: string) {
  return {
    bindingId,
    activationGeneration: 1,
    desired: "private" as const,
    status: "active" as const,
    transition: null,
    correlationKey: `publication:${bindingId}`,
    appId,
    publicUrl: `https://${appId}.example.test`,
    registrationId: `registration-${bindingId}`,
    diagnostic: null,
  };
}

function fakeLivewarePorts(actions: string[]): {
  controlPlane: LivewareControlPlanePort;
  clawChat: ClawChatLivewarePort;
} {
  const deletedApps = new Set<string>();
  const removedRegistrations = new Set<string>();
  const controlPlane: LivewareControlPlanePort = {
    async connect(token) {
      actions.push(`control:connect:${token}`);
      const session: LivewareControlSession = {
        async listApps(): Promise<LivewareApp[]> {
          const bindingId = token.replace(/^token-/u, "");
          const appId = `app-${bindingId}`;
          return deletedApps.has(appId)
            ? []
            : [
                {
                  appId,
                  name: `ClawChat Connect · ${bindingId}`,
                  publicUrl: `https://${appId}.example.test`,
                },
              ];
        },
        async createApp(): Promise<LivewareApp> {
          throw new Error("not used");
        },
        async setAccessPolicy(): Promise<void> {},
        async inspectApp(appId): Promise<LivewareApp> {
          return {
            appId,
            name: `ClawChat Connect · ${appId.replace(/^app-/u, "")}`,
            publicUrl: `https://${appId}.example.test`,
          };
        },
        async bindTunnel(): Promise<string> {
          throw new Error("not used");
        },
        async unbindTunnel(appId): Promise<void> {
          actions.push(`tunnel:unbind:${appId}`);
        },
        async deleteApp(appId): Promise<void> {
          deletedApps.add(appId);
          actions.push(`app:delete:${appId}`);
        },
      };
      return session;
    },
  };
  const clawChat: ClawChatLivewarePort = {
    async list(principal) {
      const appId = `app-${principal.localAgentId}`;
      return removedRegistrations.has(appId)
        ? []
        : [
            {
              livewareId: appId,
              name: `ClawChat Connect · ${principal.localAgentId}`,
              subtitle: "Private Connect Client",
              url: `https://${appId}.example.test`,
            },
          ];
    },
    async register() {},
    async unregister(principal, _deviceId, appId) {
      actions.push(`registration:remove:${principal.localAgentId}:${appId}:${principal.accessToken}`);
      removedRegistrations.add(appId);
    },
  };
  return { controlPlane, clawChat };
}

function captureIo(): {
  stdout: string[];
  stderr: string[];
  deps: { writeStdout: (value: string) => void; writeStderr: (value: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
