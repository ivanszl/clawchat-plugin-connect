import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawChatApiClient } from "../src/clawchat/api-client";
import {
  type Envelope,
  EVENT,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/clawchat/protocol";
import { PLUGIN_MANAGER_CONFIG_HEADER } from "../src/client-contract";
import { BINDING_SCOPE_HEADER } from "../src/client-interface/binding-scoped-gateway";
import { type ClientHttpServerOptions, startClientInterface } from "../src/client-interface/server";
import { defaultConfig, getAgentBinding, loadConfig, saveConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { createAgentBinding } from "../src/plugin/binding";
import type { ConnectPluginContext } from "../src/plugin/sdk";
import { installLocalPlugin, listInstalledPlugins, removeInstalledPlugin } from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { startBindingRuntime } from "../src/service/binding-runtime";
import { runConnectCli } from "../src/service/cli";
import { startConnectService } from "../src/service/connect-service";
import type { ActivationCredentials } from "../src/types";

const PUBLIC_CONTEXT_KEYS: Array<keyof ConnectPluginContext> = [
  "hostCapabilities",
  "installationConfiguration",
  "interfaceVersion",
];

interface ReferenceExposureFixture {
  readonly activationKeys: string[];
  readonly activationFrozen: boolean;
  readonly configurationFrozen: boolean;
  readonly clientKeys: string[];
  readonly clientFrozen: boolean;
  fetch(request: Request): Promise<Response>;
}

function referenceExposure(): ReferenceExposureFixture {
  const exposure = Reflect.get(globalThis, "__connectReferenceExposure") as ReferenceExposureFixture | undefined;
  if (!exposure) throw new Error("Reference Exposure fixture is not active");
  return exposure;
}

class MemoryTransport implements Transport {
  state: TransportState = "closed";
  handlers: TransportEvents | null = null;
  sent: Envelope[] = [];

  async connect(_url: string, handlers: TransportEvents): Promise<void> {
    this.state = "open";
    this.handlers = handlers;
    handlers.onOpen();
    handlers.onMessage(
      JSON.stringify({
        version: "2",
        event: EVENT.CONNECT_CHALLENGE,
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
      }),
    );
  }

  send(data: string): void {
    const envelope = parseEnvelope(data);
    this.sent.push(envelope);
    if (envelope.event !== EVENT.CONNECT) return;
    this.handlers?.onMessage(
      JSON.stringify({
        version: "2",
        event: EVENT.HELLO_OK,
        trace_id: envelope.trace_id,
        emitted_at: 2,
        payload: { device_id: "plugin-test-device", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
      }),
    );
  }

  close(): void {
    this.state = "closed";
  }
}

function activation(agentId: string): ActivationCredentials {
  return {
    localAgentId: agentId,
    accessToken: `token-${agentId}`,
    refreshToken: null,
    serverAgentId: `server-${agentId}`,
    userId: `user-${agentId}`,
    ownerUserId: "owner-1",
    conversationId: `chat-${agentId}`,
  };
}

async function localRequest(
  fetchHandler: ClientHttpServerOptions["fetch"],
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(origin).host);
  if (!headers.has("origin")) headers.set("origin", origin);
  return await fetchHandler(new Request(new URL(path, origin), { ...init, headers }));
}

describe("local Runtime Plugin platform", () => {
  it("runs class-instance Plugin providers through activation, Client Turn start, and disposal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-platform-"));
    Reflect.deleteProperty(globalThis, "__connectReferenceExposure");
    Reflect.deleteProperty(globalThis, "__connectReferenceExposureEffects");
    const configPath = join(directory, "config.json");
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const fixturePath = join(import.meta.dir, "fixtures", "reference-runtime.connect-plugin");
    const secondBundlePath = join(directory, "reference-runtime-two.connect-plugin");
    const secondBundle = JSON.parse(await readFile(fixturePath, "utf8")) as { manifest: { pluginId: string } };
    secondBundle.manifest.pluginId = "test.reference-runtime-two";
    await writeFile(secondBundlePath, `${JSON.stringify(secondBundle, null, 2)}\n`);

    const firstInstall = await installLocalPlugin({ configPath, bundlePath: fixturePath });
    const secondInstall = await installLocalPlugin({ configPath, bundlePath: secondBundlePath });
    expect(firstInstall.activeArtifact).not.toBe(secondInstall.activeArtifact);
    expect(firstInstall.activeArtifact).toContain("plugins");
    await expect(listInstalledPlugins(configPath)).resolves.toHaveLength(2);

    let config = defaultConfig();
    config.stateDbPath = stateStore.dbPath;
    config.livewareAccessPolicy = "off";
    config.clientHost = "127.0.0.1";
    config.clientPort = 47_823;
    config = upsertAgentBinding(
      config,
      "trace-alpha",
      createAgentBinding({
        pluginId: firstInstall.pluginId,
        capabilityId: "reference-runtime",
        configuration: { instance: "alpha" },
      }),
    );
    config = upsertAgentBinding(
      config,
      "trace-beta",
      createAgentBinding({
        pluginId: secondInstall.pluginId,
        capabilityId: "reference-runtime",
        configuration: { instance: "beta" },
      }),
    );
    await saveConfig(config, configPath);
    await stateStore.upsertActivation(activation("trace-alpha"));
    await stateStore.upsertActivation(activation("trace-beta"));
    const serviceErrors: string[] = [];
    let resolveFetchHandler!: (handler: ClientHttpServerOptions["fetch"]) => void;
    const fetchHandlerReady = new Promise<ClientHttpServerOptions["fetch"]>((resolve) => {
      resolveFetchHandler = resolve;
    });
    let resolveRuntimeAdapters!: (registry: RuntimeAdapterRegistry) => void;
    const runtimeAdaptersReady = new Promise<RuntimeAdapterRegistry>((resolve) => {
      resolveRuntimeAdapters = resolve;
    });
    let resolveClientBound!: () => void;
    const clientBoundReady = new Promise<void>((resolve) => {
      resolveClientBound = resolve;
    });
    let releaseService: (() => void) | undefined;
    const shutdown = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    const service = startConnectService(
      {
        config,
        configPath,
        stateStore,
        waitUntilShutdown: async () => await shutdown,
        writeOutput: (message) => {
          if (message.startsWith("Connect Client is available at ")) resolveClientBound();
        },
        writeError: (message) => serviceErrors.push(message),
      },
      {
        createRuntimeAdapterRegistry: () => {
          const registry = new RuntimeAdapterRegistry([]);
          resolveRuntimeAdapters(registry);
          return registry;
        },
        verifyInstalledSkills: async () => undefined,
        resolveClientAssetsPath: async () => {
          const assets = join(directory, "assets");
          await mkdir(assets, { recursive: true });
          return assets;
        },
        startBindingRuntime: async (options) => {
          const clawChatApi: ClawChatApiClient = {
            agentsConnect: async () => {
              throw new Error("activation is outside this Plugin Platform scenario");
            },
            getUserProfile: async () => ({ nickname: "Owner" }),
            updateMyProfile: async () => undefined,
            getMyGroupSettings: async () => ({ authoritative: true, rows: [] }),
          };
          return await startBindingRuntime({
            ...options,
            wsTransport: new MemoryTransport(),
            clawChatApi,
            verifyInstalledSkills: async () => undefined,
          });
        },
        startClientInterface: async (options) =>
          await startClientInterface({
            ...options,
            serverFactory: (serverOptions) => {
              resolveFetchHandler(serverOptions.fetch);
              return { port: serverOptions.port, stop: () => undefined };
            },
          }),
      },
    );

    const [handler, registry] = await Promise.race([
      Promise.all([fetchHandlerReady, runtimeAdaptersReady, clientBoundReady]),
      service.then(() => {
        throw new Error("Connect Service stopped before the Plugin test surfaces became ready");
      }),
    ]);
    const exposure = referenceExposure();
    expect(exposure).toMatchObject({
      activationKeys: ["client", "configuration"],
      activationFrozen: true,
      configurationFrozen: true,
      clientKeys: ["fetch"],
      clientFrozen: true,
    });
    expect(Reflect.get(globalThis, "__connectReferenceExposureEffects")).toEqual([
      "activate:private",
      "activate:private",
    ]);
    const exposedBootstrapResponse = await exposure.fetch(
      new Request("https://external-exposure.example/client/v1/bootstrap", {
        headers: {
          [BINDING_SCOPE_HEADER]: "trace-alpha",
          [PLUGIN_MANAGER_CONFIG_HEADER]: "/unrelated/connect/config.json",
        },
      }),
    );
    expect(exposedBootstrapResponse.status).toBe(200);
    const exposedBootstrap = (await exposedBootstrapResponse.json()) as {
      bindings: Array<{ bindingId: string }>;
    };
    expect(exposedBootstrap.bindings.map(({ bindingId }) => bindingId).sort()).toEqual(["trace-alpha", "trace-beta"]);
    expect(registry.modesFor(getAgentBinding(config, "trace-alpha"))).toEqual(["trace"]);
    expect(registry.modesFor(getAgentBinding(config, "trace-beta"))).toEqual(["trace"]);

    const projectRoot = join(directory, "workspace");
    await mkdir(projectRoot);
    const projectResponse = await localRequest(handler, "http://127.0.0.1:47823", "/client/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "plugin_project_create",
        directory: { kind: "existing-directory", rootPath: projectRoot },
      }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { workspaceId: string };
    const sessionResponse = await localRequest(handler, "http://127.0.0.1:47823", "/client/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "plugin_session_create",
        bindingId: "trace-alpha",
        workspace: { kind: "existing", workspaceId: project.workspaceId },
        name: "Plugin tracer",
        mode: "trace",
        model: null,
        reasoningEffort: null,
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { sessionRef: string };
    const turnBody = new FormData();
    turnBody.append("prompt", "hello plugin");
    const turnResponse = await localRequest(
      handler,
      "http://127.0.0.1:47823",
      `/client/v1/sessions/${session.sessionRef}/turn-submissions/plugin_turn_1`,
      { method: "POST", body: turnBody },
    );
    if (turnResponse.status !== 202) {
      throw new Error(
        `Plugin Turn submission failed (${turnResponse.status}): ${await turnResponse.text()}\n${serviceErrors.join("")}`,
      );
    }

    let runtimeThreadId: string | null = null;
    for (let attempt = 0; attempt < 100 && !runtimeThreadId; attempt += 1) {
      runtimeThreadId = (await stateStore.getRuntimeSessionByRef(session.sessionRef))?.runtimeSessionId ?? null;
      if (!runtimeThreadId) await Bun.sleep(1);
    }
    expect(runtimeThreadId).toBe("alpha-trace-alpha-thread-1");
    if (!runtimeThreadId) throw new Error("Reference Runtime did not report Runtime Thread identity");
    const activity = await registry.readActivity(getAgentBinding(config, "trace-alpha"), runtimeThreadId);
    expect(activity.activities).toMatchObject([
      {
        text: "alpha:hello plugin",
        data: { contextKeys: [...PUBLIC_CONTEXT_KEYS].sort(), instance: "alpha" },
      },
    ]);

    const transcriptResponse = await localRequest(
      handler,
      "http://127.0.0.1:47823",
      `/client/v1/sessions/${session.sessionRef}/transcript`,
    );
    expect(transcriptResponse.status).toBe(200);
    expect(JSON.stringify(await transcriptResponse.json())).toContain("alpha:hello plugin");

    const output: string[] = [];
    await expect(
      runConnectCli(["plugin", "list", "--config", configPath], {
        writeStdout: (value) => output.push(value),
        writeStderr: (value) => output.push(value),
        pluginManagementFetch: async () => {
          throw new Error("Plugin manager is not listening in this injected service");
        },
      }),
    ).resolves.toBe(0);
    expect(output.join("\n")).toContain("source: local:");
    expect(output.join("\n")).toContain("reference-runtime (runtime:reference)");
    expect(output.join("\n")).toContain("dependent Bindings: trace-alpha");
    expect(output.join("\n")).toContain("dependent Bindings: trace-beta");

    releaseService?.();
    await expect(service).resolves.toEqual({ startedAgentIds: ["trace-alpha", "trace-beta"] });
    await expect(registry.prepare(getAgentBinding(config, "trace-alpha"))).rejects.toThrow("is not active");
    expect(Reflect.get(globalThis, "__connectReferenceExposure")).toBeUndefined();
    expect(Reflect.get(globalThis, "__connectReferenceExposureEffects")).toEqual([
      "activate:private",
      "activate:private",
      "dispose",
      "dispose",
    ]);
    await removeInstalledPlugin(configPath, firstInstall.pluginId);
    expect((await listInstalledPlugins(configPath)).map((plugin) => plugin.pluginId)).toEqual([secondInstall.pluginId]);
    expect(await loadConfig(configPath)).toMatchObject({
      agents: {
        "trace-alpha": {
          runtime: { pluginId: firstInstall.pluginId, capabilityId: "reference-runtime" },
          runtimeConfig: { instance: "alpha" },
        },
      },
    });
  });
});
