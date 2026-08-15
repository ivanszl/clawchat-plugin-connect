import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PLUGIN_BUNDLE_BYTES } from "../src/client-contract";
import { BINDING_SCOPE_HEADER } from "../src/client-interface/binding-scoped-gateway";
import {
  type ClientHttpServerOptions,
  type ClientHttpServerRequestContext,
  type ClientInterfaceHandle,
  startClientInterface,
} from "../src/client-interface/server";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { type ConnectStateStore, createStateStore } from "../src/persistence/state";
import { createPluginAgentBinding } from "../src/plugin/binding";
import type { OfficialPluginDiscovery } from "../src/plugin/catalog";
import type { ConfigurePluginOptions, ConnectPluginHost, ManagePluginOptions } from "../src/plugin/host";
import { type InstalledPluginLockEntry, validatePluginConfiguration } from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";

const handles: ClientInterfaceHandle[] = [];
const stores: ConnectStateStore[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => await handle.stop()));
  await Promise.all(stores.splice(0).map(async (store) => await store.close()));
});

describe("Connect Client trusted Plugin administration", () => {
  it("projects complete DTOs and exercises only explicit installation-level commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-plugins-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.clientPort = 47_896;
    config.agents["plugin-binding"] = {
      ...createPluginAgentBinding({
        runtimeFamily: "fixture",
        pluginId: "test.healthy",
        capabilityId: "runtime",
        configuration: { workspace: "isolated" },
      }),
      displayName: "Fixture Binding",
    };
    const store = createStateStore({ dbPath: config.stateDbPath });
    stores.push(store);
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([
      {
        kind: "fixture",
        runtime: { pluginId: "test.healthy", capabilityId: "runtime" },
        create: () => ({
          kind: "fixture",
          modes: ["read-only"],
          start: async () => ({
            prompt: async function* () {},
            close: async () => undefined,
          }),
        }),
      },
    ]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });

    const healthy = installedPlugin("test.healthy", "active", null);
    const failed = installedPlugin("test.failed", "error", "provider registration failed after import");
    const installed = [healthy, failed];
    const install = mock(async (_options: ManagePluginOptions) => healthy);
    const installUpload = mock(
      async (_name: string, _bytes: Uint8Array, _options: Omit<ManagePluginOptions, "source">) => healthy,
    );
    const installOfficial = mock(async (_pluginIds: readonly string[]) => [healthy]);
    const update = mock(async (_pluginId: string, _options?: Partial<ManagePluginOptions>) => healthy);
    const reinstall = mock(async (_pluginId: string) => healthy);
    const enable = mock(async (_pluginId: string) => healthy);
    const configure = mock(async (_pluginId: string, options: ConfigurePluginOptions) => {
      validatePluginConfiguration(
        healthy.manifest.installationConfigurationSchema,
        options.installationConfiguration,
        "Client installation configuration",
      );
      const runtimeCapability = healthy.manifest.capabilities[0]!;
      for (const [bindingId, configuration] of Object.entries(options.runtimeConfigurations)) {
        validatePluginConfiguration(
          runtimeCapability.configurationSchema,
          configuration,
          `Client Runtime configuration ${bindingId}`,
        );
      }
      return healthy;
    });
    const disable = mock(async (_pluginId: string) => healthy);
    const select = mock(async (_pluginId: string, _version: string, _integrity?: string) => healthy);
    const remove = mock(async (_pluginId: string, _force?: boolean) => healthy);
    const official: OfficialPluginDiscovery = {
      catalogOrigin: "cache",
      diagnostics: ["Official Plugin Catalog is using the last authenticated cache"],
      candidates: [
        {
          pluginId: "official.fixture",
          name: "Official Fixture",
          source: "npm:@clawchat/fixture@1.2.0",
          resolvedSource: {
            type: "npm",
            package: "@clawchat/fixture",
            registry: "https://registry.example.test",
            version: "1.2.0",
            tarball: "https://registry.example.test/fixture.tgz",
          },
          version: "1.2.0",
          target: "test-target",
          integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          detected: true,
          compatible: true,
          selected: true,
          selectable: true,
          probe: { detected: true, compatible: true },
          diagnostic: null,
          installationConfiguration: { channel: "stable" },
          exposureConfigurations: {},
          manifest: healthy.manifest,
        },
      ],
    };
    const pluginManager = {
      list: mock(async () => installed),
      checkUpdates: mock(async () => ({
        "test.healthy": {
          status: "available" as const,
          version: "2.0.0",
          integrity: "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
          diagnostic: null,
        },
        "test.failed": {
          status: "check-failed" as const,
          version: null,
          integrity: null,
          diagnostic: "registry unavailable",
        },
      })),
      discoverOfficial: mock(async () => official),
      install,
      installUpload,
      installOfficial,
      update,
      reinstall,
      enable,
      disable,
      select,
      remove,
      configure,
    } as unknown as ConnectPluginHost;
    let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
    const handle = await startClientInterface({
      config,
      configPath,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      pluginManager,
      runtimes: [],
      assetsPath: directory,
      port: config.clientPort,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    handles.push(handle);
    if (!fetchHandler) throw new Error("Client Interface did not expose its request handler");
    const handleRequest: (request: Request) => Response | Promise<Response> = fetchHandler;

    const administration = await request(fetchHandler, handle.origin, "/client/v1/plugins/administration");
    expect(administration.status).toBe(200);
    await expect(administration.json()).resolves.toMatchObject({
      installed: [
        {
          kind: "installed",
          pluginId: "test.healthy",
          source: { type: "local" },
          version: "1.0.0",
          integrity: healthy.integrity,
          status: "active",
          dependentBindings: [{ bindingId: "plugin-binding", capabilityId: "runtime" }],
          updateAvailability: { status: "available", version: "2.0.0" },
          retainedVersions: [{ version: "0.9.0" }],
          installationConfigurationSchema: healthy.manifest.installationConfigurationSchema,
          installationConfiguration: { channel: "stable" },
          capabilities: [
            {
              id: "runtime",
              type: "runtime",
              instances: [{ bindingId: "plugin-binding", configuration: { workspace: "isolated" } }],
            },
          ],
          diagnostics: [],
        },
        {
          pluginId: "test.failed",
          status: "error",
          diagnostics: [
            { stage: "provider", message: "provider registration failed after import" },
            { stage: "update", message: "registry unavailable" },
          ],
        },
      ],
      available: [
        {
          kind: "available",
          pluginId: "official.fixture",
          source: { type: "npm", version: "1.2.0" },
          version: "1.2.0",
          capabilities: [{ id: "runtime", configurationSchema: healthy.manifest.capabilities[0]?.configurationSchema }],
          status: "available",
          updateAvailability: { status: "not-installed" },
        },
      ],
      catalogOrigin: "cache",
    });
    expect(update).toHaveBeenCalledTimes(0);

    await expect(
      request(fetchHandler, handle.origin, "/client/v1/plugins/administration", {
        headers: { [BINDING_SCOPE_HEADER]: "plugin-binding" },
      }).then((response) => response.status),
    ).resolves.toBe(404);

    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins", {
          method: "POST",
          json: {
            source: "npm:@clawchat/fixture@1.2.0",
            installationConfiguration: { channel: "stable" },
            exposureConfigurations: {},
          },
        })
      ).status,
    ).toBe(201);
    expect(install).toHaveBeenCalledWith({
      source: "npm:@clawchat/fixture@1.2.0",
      installationConfiguration: { channel: "stable" },
      exposureConfigurations: {},
    });

    const form = new FormData();
    form.set("bundle", new File(["fixture Bundle bytes"], "fixture.connect-plugin"));
    form.set("installationConfiguration", JSON.stringify({ channel: "local" }));
    form.set("exposureConfigurations", JSON.stringify({ exposure: { enabled: true } }));
    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/upload", {
          method: "POST",
          body: form,
        })
      ).status,
    ).toBe(201);
    expect(installUpload).toHaveBeenCalledWith(
      "fixture.connect-plugin",
      new TextEncoder().encode("fixture Bundle bytes"),
      {
        installationConfiguration: { channel: "local" },
        exposureConfigurations: { exposure: { enabled: true } },
      },
    );

    const declaredOversizeForm = new FormData();
    declaredOversizeForm.set("bundle", new File(["small"], "declared-oversize.connect-plugin"));
    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/upload", {
          method: "POST",
          headers: { "content-length": String(MAX_PLUGIN_BUNDLE_BYTES + 1024 * 1024 + 1) },
          body: declaredOversizeForm,
        })
      ).status,
    ).toBe(413);

    const boundary = "connect-plugin-upload-limit";
    const multipartPrefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="lengthless.connect-plugin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const lengthlessOversizeRequest = new Request(`${handle.origin}/client/v1/plugins/upload`, {
      method: "POST",
      headers: {
        origin: handle.origin,
        host: new URL(handle.origin).host,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(multipartPrefix);
          controller.enqueue(new Uint8Array(MAX_PLUGIN_BUNDLE_BYTES));
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.close();
        },
      }),
    });
    expect(lengthlessOversizeRequest.headers.has("content-length")).toBe(false);
    const unexpectedFormDataParse = mock(async (): Promise<FormData> => {
      throw new Error("oversize multipart body reached FormData parsing");
    });
    Object.defineProperty(lengthlessOversizeRequest, "formData", { value: unexpectedFormDataParse });
    expect((await handleRequest(lengthlessOversizeRequest)).status).toBe(413);
    expect(unexpectedFormDataParse).toHaveBeenCalledTimes(0);

    const exactOversizeForm = new FormData();
    exactOversizeForm.set(
      "bundle",
      new File([new Uint8Array(MAX_PLUGIN_BUNDLE_BYTES + 1)], "exact-oversize.connect-plugin"),
    );
    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/upload", {
          method: "POST",
          headers: { "content-length": "0" },
          body: exactOversizeForm,
        })
      ).status,
    ).toBe(413);
    expect(installUpload).toHaveBeenCalledTimes(1);

    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/official/setup", {
          method: "POST",
          json: { pluginIds: ["official.fixture"] },
        })
      ).status,
    ).toBe(201);
    expect(installOfficial).toHaveBeenCalledWith(["official.fixture"]);

    const configuration = {
      installationConfiguration: { channel: "canary" },
      exposureConfigurations: {},
      runtimeConfigurations: { "plugin-binding": { workspace: "shared" } },
    };
    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/test.healthy/configure", {
          method: "POST",
          json: configuration,
        })
      ).status,
    ).toBe(200);
    expect(configure).toHaveBeenCalledWith("test.healthy", configuration);
    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/test.healthy/configure", {
          method: "POST",
          json: { ...configuration, runtimeConfigurations: [] },
        })
      ).status,
    ).toBe(400);
    const schemaFailure = await request(fetchHandler, handle.origin, "/client/v1/plugins/test.healthy/configure", {
      method: "POST",
      json: {
        ...configuration,
        runtimeConfigurations: { "plugin-binding": { workspace: 42 } },
      },
    });
    expect(schemaFailure.status).toBe(409);
    await expect(schemaFailure.json()).resolves.toMatchObject({
      error: { code: "plugin-operation-failed", message: expect.stringContaining("must be string") },
    });

    for (const actionName of ["update", "reinstall", "disable", "enable"] as const) {
      expect(
        (
          await request(fetchHandler, handle.origin, `/client/v1/plugins/test.healthy/${actionName}`, {
            method: "POST",
            json: {},
          })
        ).status,
      ).toBe(200);
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(reinstall).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledTimes(1);

    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/test.healthy/select", {
          method: "POST",
          json: { version: "0.9.0", integrity: healthy.retainedVersions[0]?.integrity },
        })
      ).status,
    ).toBe(200);
    expect(select).toHaveBeenCalledWith("test.healthy", "0.9.0", healthy.retainedVersions[0]?.integrity);

    expect(
      (
        await request(fetchHandler, handle.origin, "/client/v1/plugins/test.healthy?force=1", {
          method: "DELETE",
          json: {},
        })
      ).status,
    ).toBe(200);
    expect(remove).toHaveBeenCalledWith("test.healthy", true);
  });

  it("keeps Plugin administration on actual loopback and private Liveware peers in trusted-LAN mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-plugin-peer-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.clientHost = "0.0.0.0";
    config.clientPort = 47_897;
    config.agents["private-binding"] = createPluginAgentBinding({
      runtimeFamily: "fixture",
      pluginId: "test.private-liveware",
      capabilityId: "runtime",
      configuration: {},
    });
    const store = createStateStore({ dbPath: config.stateDbPath });
    stores.push(store);
    await store.initialize();
    await store.setLivewareExposure({
      ownerUserId: "owner",
      localAgentId: "private-binding",
      appId: "private-app",
      publicUrl: "https://private-liveware.example.test/client",
      accessPolicy: "private",
    });
    const registry = new RuntimeAdapterRegistry([
      {
        kind: "fixture",
        runtime: { pluginId: "test.private-liveware", capabilityId: "runtime" },
        create: () => ({
          kind: "fixture",
          modes: [],
          start: async () => ({
            prompt: async function* () {},
            close: async () => undefined,
          }),
        }),
      },
    ]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const list = mock(async () => []);
    const install = mock(async () => ({ pluginId: "test.private-liveware" }));
    const pluginManager = { list, install } as unknown as ConnectPluginHost;
    let fetchHandler: ClientHttpServerOptions["fetch"] | null = null;
    const handle = await startClientInterface({
      config,
      configPath,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      pluginManager,
      runtimes: [],
      assetsPath: directory,
      serverFactory: (options) => {
        fetchHandler = options.fetch;
        return { stop: async () => undefined };
      },
    });
    handles.push(handle);
    if (!fetchHandler) throw new Error("Client Interface did not expose its request handler");

    const lanOrigin = `http://192.168.1.20:${config.clientPort}`;
    const remotePeer: ClientHttpServerRequestContext = {
      requestIP: () => ({ address: "192.168.1.40" }),
    };
    const loopbackPeer: ClientHttpServerRequestContext = {
      requestIP: () => ({ address: "127.0.0.1" }),
    };
    const remoteRoutes = [
      ["GET", "/client/v1/plugins/administration"],
      ["GET", "/client/v1/plugins/official"],
      ["GET", "/client/v1/plugins"],
      ["POST", "/client/v1/plugins/upload"],
      ["POST", "/client/v1/plugins/official/setup"],
      ["POST", "/client/v1/plugins"],
      ["POST", "/client/v1/plugins/test.plugin/update"],
      ["POST", "/client/v1/plugins/test.plugin/reinstall"],
      ["POST", "/client/v1/plugins/test.plugin/configure"],
      ["POST", "/client/v1/plugins/test.plugin/enable"],
      ["POST", "/client/v1/plugins/test.plugin/disable"],
      ["POST", "/client/v1/plugins/test.plugin/select"],
      ["DELETE", "/client/v1/plugins/test.plugin"],
    ] as const;
    for (const [method, path] of remoteRoutes) {
      const response = await request(
        fetchHandler,
        lanOrigin,
        path,
        method === "GET" ? {} : { method, json: {} },
        remotePeer,
      );
      expect(response.status).toBe(404);
    }
    expect((await request(fetchHandler, lanOrigin, "/client/v1/bootstrap", {}, remotePeer)).status).toBe(200);
    expect((await request(fetchHandler, lanOrigin, "/client/v1/plugins", {}, loopbackPeer)).status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);

    const privateLiveware = await request(
      fetchHandler,
      lanOrigin,
      "/client/v1/plugins",
      {
        method: "POST",
        headers: {
          origin: "https://private-liveware.example.test",
          [BINDING_SCOPE_HEADER]: "private-binding",
        },
        json: { source: "npm:@clawchat/private-liveware-plugin@1.0.0" },
      },
      loopbackPeer,
    );
    expect(privateLiveware.status).toBe(201);
    expect(install).toHaveBeenCalledWith({ source: "npm:@clawchat/private-liveware-plugin@1.0.0" });

    await store.setLivewareExposure({
      ownerUserId: "owner",
      localAgentId: "private-binding",
      appId: "private-app",
      publicUrl: "https://public-liveware.example.test/client",
      accessPolicy: "public",
    });
    const publicLiveware = await request(
      fetchHandler,
      lanOrigin,
      "/client/v1/plugins",
      { headers: { [BINDING_SCOPE_HEADER]: "private-binding" } },
      loopbackPeer,
    );
    expect(publicLiveware.status).toBe(404);
  });
});

function installedPlugin(
  pluginId: string,
  status: InstalledPluginLockEntry["status"],
  error: string | null,
): InstalledPluginLockEntry {
  const integrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const version = {
    source: { type: "local" as const, path: `/fixtures/${pluginId}.connect-plugin` },
    version: "1.0.0",
    target: "test-target",
    integrity,
    activeArtifact: `/fixtures/${pluginId}/entry.mjs`,
    manifestPath: `/fixtures/${pluginId}/connect-plugin.json`,
    manifest: {
      manifestVersion: 1 as const,
      interfaceVersion: "1" as const,
      pluginId,
      version: "1.0.0",
      dependencies: [{ type: "host" as const, id: "runtime-provider" as const, interfaceVersion: "1" as const }],
      installationConfigurationSchema: {
        type: "object",
        properties: { channel: { type: "string", enum: ["stable", "canary"] } },
        additionalProperties: false,
      },
      capabilities: [
        {
          id: "runtime",
          type: "runtime" as const,
          interfaceVersion: "1" as const,
          family: "fixture",
          configurationSchema: {
            type: "object",
            properties: { workspace: { type: "string" } },
            required: ["workspace"],
            additionalProperties: false,
          },
        },
      ],
      artifacts: [{ target: "test-target", entry: "entry.mjs", integrity }],
    },
    installationConfiguration: { channel: "stable" },
    exposureConfigurations: {},
  };
  return {
    pluginId,
    ...version,
    status,
    error,
    retainedVersions: [{ ...version, version: "0.9.0", manifest: { ...version.manifest, version: "0.9.0" } }],
  };
}

async function request(
  fetchHandler: ClientHttpServerOptions["fetch"],
  origin: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    json?: unknown;
    body?: BodyInit;
  } = {},
  requestServer?: ClientHttpServerRequestContext,
): Promise<Response> {
  const headers = new Headers({ origin, ...options.headers });
  headers.set("host", new URL(origin).host);
  if (options.json !== undefined) headers.set("content-type", "application/json");
  return await fetchHandler(
    new Request(`${origin}${path}`, {
      method: options.method,
      headers,
      body: options.body ?? (options.json === undefined ? undefined : JSON.stringify(options.json)),
    }),
    requestServer,
  );
}
