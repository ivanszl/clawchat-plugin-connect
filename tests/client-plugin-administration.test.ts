import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BINDING_SCOPE_HEADER, MAX_PLUGIN_BUNDLE_BYTES } from "../src/client-contract";
import {
  type ClientHttpServerOptions,
  type ClientHttpServerRequestContext,
  type ClientInterfaceHandle,
  startClientInterface,
} from "../src/client-interface/server";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig, getAgentBinding, loadConfig, saveConfig } from "../src/config";
import { type ConnectStateStore, createStateStore } from "../src/persistence/state";
import { createAgentBinding } from "../src/plugin/binding";
import {
  type ConfigurePluginOptions,
  ConnectPluginHost,
  type ConnectPluginManagement,
  type ManagePluginOptions,
} from "../src/plugin/host";
import type { OfficialPluginDiscovery } from "../src/plugin/official-registry";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectPluginBundleV1,
} from "../src/plugin/sdk";
import {
  currentConnectPluginTarget,
  type InstalledPluginLockEntry,
  managedPluginUploadRoot,
  validatePluginConfiguration,
} from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { AgentBindingConfig } from "../src/types";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

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
    await mkdir(configPath);
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.clientPort = 47_896;
    config.agents["plugin-binding"] = {
      ...createAgentBinding({
        pluginId: "test.healthy",
        capabilityId: "runtime",
        configuration: { workspace: "isolated" },
      }),
      displayName: "Fixture Binding",
    };
    const store = createStateStore({ dbPath: config.stateDbPath });
    stores.push(store);
    await store.initialize();
    await store.upsertActivation({
      localAgentId: "plugin-binding",
      accessToken: "fixture-access",
      refreshToken: null,
      serverAgentId: "fixture-server-agent",
      userId: "fixture-agent-user",
      ownerUserId: "fixture-owner",
      conversationId: "fixture-conversation",
    });
    const registry = new RuntimeAdapterRegistry([
      {
        family: "fixture",
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
      const runtimeCapability = healthy.manifest.capabilities[0];
      if (!runtimeCapability) throw new Error("Expected healthy Runtime capability fixture");
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
    const upsertBindingProvider = mock(async (bindingId: string, binding: AgentBindingConfig) => {
      const nextConfig = structuredClone(config);
      nextConfig.agents[bindingId] = binding;
      if (!nextConfig.defaultAgent) nextConfig.defaultAgent = bindingId;
      await saveConfig(nextConfig, configPath);
      Object.assign(config, nextConfig);
      return { binding: structuredClone(binding), modes: ["read-only"] };
    });
    const official: OfficialPluginDiscovery = {
      officialSource: "bundled",
      diagnostics: ["Bundled official Plugin fixture"],
      candidates: [
        {
          pluginId: "official.fixture",
          name: "Official Fixture",
          source: "npm:@clawchat/fixture@1.2.0",
          resolvedSource: null,
          version: "1.2.0",
          target: "test-target",
          integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          detected: true,
          compatible: true,
          selected: true,
          selectable: true,
          discovery: { detected: true, compatible: true },
          diagnostic: null,
          installationConfiguration: { channel: "stable" },
          exposureConfigurations: {},
          manifest: healthy.manifest,
        },
      ],
    };
    const pluginManager = {
      list: mock(async () => installed),
      listPublishedClientExtensions: mock(async () => installed),
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
      upsertBindingProvider,
    } as unknown as ConnectPluginManagement;
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
          source: null,
          sourceReference: "npm:@clawchat/fixture@1.2.0",
          version: "1.2.0",
          capabilities: [{ id: "runtime", configurationSchema: healthy.manifest.capabilities[0]?.configurationSchema }],
          status: "available",
          updateAvailability: { status: "not-installed" },
        },
      ],
      officialSource: "bundled",
    });
    expect(update).toHaveBeenCalledTimes(0);

    await expect(
      request(fetchHandler, handle.origin, "/client/v1/plugins/administration", {
        headers: { [BINDING_SCOPE_HEADER]: "plugin-binding" },
      }).then((response) => response.status),
    ).resolves.toBe(404);
    const configBeforeSaveFailure = structuredClone(config);
    const bootstrapBeforeSaveFailure = await request(fetchHandler, handle.origin, "/client/v1/bootstrap").then(
      async (response) => await response.json(),
    );
    const failedBindingResponse = await request(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/failed-binding/provider",
      {
        method: "PUT",
        json: {
          requestId: "binding-provider-save-failure",
          pluginId: "test.healthy",
          capabilityId: "runtime",
          runtimeConfig: { workspace: "unsaved" },
          displayName: "Unsaved Binding",
          createOnly: true,
        },
      },
    );
    expect(failedBindingResponse.status).toBe(500);
    expect(config).toEqual(configBeforeSaveFailure);
    await expect(
      request(fetchHandler, handle.origin, "/client/v1/bootstrap").then(async (response) => await response.json()),
    ).resolves.toEqual(bootstrapBeforeSaveFailure);
    await rename(configPath, `${configPath}.save-blocker`);

    const createdBindingResponse = await request(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/new-binding/provider",
      {
        method: "PUT",
        json: {
          requestId: "binding-provider-create",
          pluginId: "test.healthy",
          capabilityId: "runtime",
          runtimeConfig: { workspace: "project" },
          displayName: "New Binding",
          createOnly: true,
        },
      },
    );
    expect(createdBindingResponse.status).toBe(200);
    await expect(createdBindingResponse.json()).resolves.toMatchObject({
      bindingId: "new-binding",
      displayName: "New Binding",
      runtimePluginId: "test.healthy",
      runtimeCapabilityId: "runtime",
      runtimeConfiguration: { workspace: "project" },
      modeOptions: ["read-only"],
    });
    expect(config.agents["new-binding"]).toEqual({
      runtime: { pluginId: "test.healthy", capabilityId: "runtime" },
      runtimeConfig: { workspace: "project" },
      displayName: "New Binding",
    });
    expect(upsertBindingProvider).toHaveBeenCalledWith(
      "new-binding",
      expect.objectContaining({
        runtime: { pluginId: "test.healthy", capabilityId: "runtime" },
        runtimeConfig: { workspace: "project" },
        displayName: "New Binding",
      }),
    );

    const duplicateBindingResponse = await request(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/new-binding/provider",
      {
        method: "PUT",
        json: {
          requestId: "binding-provider-duplicate",
          pluginId: "test.healthy",
          capabilityId: "runtime",
          runtimeConfig: { workspace: "replacement" },
          createOnly: true,
        },
      },
    );
    expect(duplicateBindingResponse.status).toBe(409);
    expect(config.agents["new-binding"]?.runtimeConfig).toEqual({ workspace: "project" });

    const invalidConfigurationResponse = await request(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/invalid-binding/provider",
      {
        method: "PUT",
        json: {
          requestId: "binding-provider-invalid",
          pluginId: "test.healthy",
          capabilityId: "runtime",
          runtimeConfig: {},
        },
      },
    );
    expect(invalidConfigurationResponse.status).toBe(400);
    expect(config.agents["invalid-binding"]).toBeUndefined();

    const activeBindingResponse = await request(
      fetchHandler,
      handle.origin,
      "/client/v1/bindings/plugin-binding/provider",
      {
        method: "PUT",
        json: {
          requestId: "binding-provider-active",
          pluginId: "test.healthy",
          capabilityId: "runtime",
          runtimeConfig: { workspace: "changed" },
        },
      },
    );
    expect(activeBindingResponse.status).toBe(409);
    expect(config.agents["plugin-binding"]?.runtimeConfig).toEqual({ workspace: "isolated" });

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

  it("atomically replaces an uploaded Plugin Bundle and rolls back a failed uploaded candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-plugin-upload-replacement-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.clientPort = 47_898;
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: config.stateDbPath });
    stores.push(store);
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const host = new ConnectPluginHost(configPath, registry, () => undefined);
    let fetchHandler: ClientHttpServerOptions["fetch"] | null = null;
    const handle = await startClientInterface({
      config,
      configPath,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      pluginManager: host,
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
    const pluginId = "test.client-upload-replacement";
    const binding = createAgentBinding({ pluginId, capabilityId: "runtime", configuration: {} });
    Reflect.set(globalThis, "__connectClientUploadLog", []);

    const v1Bundle = clientUploadBundle(pluginId, "1.0.0");
    const v1Response = await uploadPlugin(fetchHandler, handle.origin, "replacement-v1.connect-plugin", v1Bundle);
    expect(v1Response.status).toBe(201);
    const v1 = (await v1Response.json()) as InstalledPluginLockEntry;
    if (v1.source.type !== "local") throw new Error("Expected v1 upload to use a managed local source");
    expect(v1).toMatchObject({ pluginId, version: "1.0.0", integrity: v1Bundle.manifest.artifacts[0]?.integrity });
    await registry.prepare(binding);

    const v2Bundle = clientUploadBundle(pluginId, "2.0.0");
    const v2Response = await uploadPlugin(fetchHandler, handle.origin, "replacement-v2.connect-plugin", v2Bundle);
    expect(v2Response.status).toBe(201);
    const v2 = (await v2Response.json()) as InstalledPluginLockEntry;
    if (v2.source.type !== "local") throw new Error("Expected v2 upload to use a managed local source");
    expect(v2.source.path).not.toBe(v1.source.path);
    expect(basename(v2.source.path)).toBe(
      `${createHash("sha256").update(JSON.stringify(v2Bundle)).digest("hex")}.connect-plugin`,
    );
    expect(v2).toMatchObject({
      pluginId,
      version: "2.0.0",
      integrity: v2Bundle.manifest.artifacts[0]?.integrity,
      status: "active",
    });
    expect(v2.retainedVersions).toEqual([
      expect.objectContaining({
        version: "1.0.0",
        integrity: v1.integrity,
        source: { type: "local", path: v1.source.path },
      }),
    ]);
    await expect(readFile(v2.source.path, "utf8")).resolves.toContain('"version":"2.0.0"');
    const successfulReplacementLog = Reflect.get(globalThis, "__connectClientUploadLog") as string[];
    expect(successfulReplacementLog.indexOf("bundle-activate:2.0.0")).toBeLessThan(
      successfulReplacementLog.indexOf("bundle-dispose:1.0.0"),
    );
    await registry.prepare(binding);
    expect((Reflect.get(globalThis, "__connectClientUploadLog") as string[]).at(-1)).toBe("prepare:2.0.0");

    const v3Response = await uploadPlugin(
      fetchHandler,
      handle.origin,
      "replacement-v3.connect-plugin",
      clientUploadBundle(pluginId, "3.0.0", true),
    );
    expect(v3Response.status).toBe(409);
    await expect(v3Response.json()).resolves.toMatchObject({
      error: { code: "plugin-operation-failed", message: "uploaded candidate activation failed" },
    });
    await registry.prepare(binding);
    expect((Reflect.get(globalThis, "__connectClientUploadLog") as string[]).at(-1)).toBe("prepare:2.0.0");
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        version: "2.0.0",
        integrity: v2.integrity,
        source: { type: "local", path: v2.source.path },
        status: "active",
        retainedVersions: [
          expect.objectContaining({
            version: "1.0.0",
            integrity: v1.integrity,
            source: { type: "local", path: v1.source.path },
          }),
        ],
      }),
    ]);
    expect((await readdir(managedPluginUploadRoot(configPath))).sort()).toEqual(
      [basename(v1.source.path), basename(v2.source.path)].sort(),
    );
    const removalResponse = await request(
      fetchHandler,
      handle.origin,
      `/client/v1/plugins/${encodeURIComponent(pluginId)}`,
      { method: "DELETE" },
    );
    expect(removalResponse.status).toBe(200);
    expect(await readdir(managedPluginUploadRoot(configPath))).toEqual([]);

    await host.close();
  });

  it("defers Codex provider construction until Binding selection and commits the validated instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-deferred-provider-"));
    const configPath = join(directory, "config.json");
    const executablePath = join(directory, "codex-installed-later");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.clientPort = 47_899;
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: config.stateDbPath });
    stores.push(store);
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    let fetchHandler: ClientHttpServerOptions["fetch"] | null = null;
    const handle = await startClientInterface({
      config,
      configPath,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
      pluginManager: host,
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
    Reflect.set(globalThis, "__connectDeferredProviderLog", []);
    const pluginId = "test.deferred-codex";
    const installed = await uploadPlugin(
      fetchHandler,
      handle.origin,
      "deferred-codex.connect-plugin",
      deferredCodexBundle(pluginId),
    );
    expect(installed.status).toBe(201);

    const requestBody = {
      requestId: "deferred-codex-selection",
      pluginId,
      capabilityId: "runtime",
      runtimeConfig: { executablePathOverride: executablePath },
      displayName: "Deferred Codex",
      createOnly: true,
    };
    const liveBefore = structuredClone(config);
    const persistedBefore = await readFile(configPath, "utf8");
    const failed = await request(fetchHandler, handle.origin, "/client/v1/bindings/deferred-codex/provider", {
      method: "PUT",
      json: requestBody,
    });
    expect(failed.status).toBe(409);
    await expect(failed.json()).resolves.toMatchObject({
      error: {
        code: "runtime-provider-invalid",
        message: `Failed to inspect configured Codex executable ${executablePath}`,
      },
    });
    expect(config).toEqual(liveBefore);
    await expect(readFile(configPath, "utf8")).resolves.toBe(persistedBefore);

    await writeFile(executablePath, "#!/bin/sh\nprintf 'codex-cli 0.111.0\\n'\n", { mode: 0o700 });
    const selected = await request(fetchHandler, handle.origin, "/client/v1/bindings/deferred-codex/provider", {
      method: "PUT",
      json: requestBody,
    });
    expect(selected.status).toBe(200);
    await expect(selected.json()).resolves.toMatchObject({
      bindingId: "deferred-codex",
      displayName: "Deferred Codex",
      runtimeKind: "codex",
      runtimeConfiguration: { executablePathOverride: executablePath },
      modeOptions: ["read-only", "workspace-write"],
    });
    expect(Reflect.get(globalThis, "__connectDeferredProviderLog") as string[]).toEqual(["create", "create", "modes"]);
    expect(registry.modesFor(getAgentBinding(config, "deferred-codex"))).toEqual(["read-only", "workspace-write"]);
    expect(Reflect.get(globalThis, "__connectDeferredProviderLog") as string[]).toEqual([
      "create",
      "create",
      "modes",
      "modes",
    ]);
    await expect(loadConfig(configPath)).resolves.toMatchObject({
      defaultAgent: "deferred-codex",
      agents: {
        "deferred-codex": {
          runtime: { pluginId, capabilityId: "runtime" },
          runtimeConfig: { executablePathOverride: executablePath },
          displayName: "Deferred Codex",
        },
      },
    });
    await host.close();
  });

  it("keeps Plugin administration on actual loopback and hides it from scoped requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-plugin-peer-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.clientHost = "0.0.0.0";
    config.clientPort = 47_897;
    config.agents["private-binding"] = createAgentBinding({
      pluginId: "test.private-liveware",
      capabilityId: "runtime",
      configuration: {},
    });
    const store = createStateStore({ dbPath: config.stateDbPath });
    stores.push(store);
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([
      {
        family: "fixture",
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
    const pluginManager = {
      list,
      listPublishedClientExtensions: async () => [],
      install,
    } as unknown as ConnectPluginManagement;
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
    const administrationRoutes = [
      ["GET", "/client/v1/plugins/administration"],
      ["GET", "/client/v1/plugins/official"],
      ["PUT", "/client/v1/bindings/private-binding/provider"],
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
    for (const [method, path] of administrationRoutes) {
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
    expect(list).toHaveBeenCalledTimes(2);

    for (const [method, path] of administrationRoutes) {
      const response = await request(
        fetchHandler,
        lanOrigin,
        path,
        {
          ...(method === "GET" ? {} : { method, json: {} }),
          headers: {
            origin: "https://private-liveware.example.test",
            [BINDING_SCOPE_HEADER]: "private-binding",
          },
        },
        loopbackPeer,
      );
      expect(response.status).toBe(404);
    }
    expect(list).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(0);
  });
});

function clientUploadBundle(pluginId: string, version: string, failActivation = false): ConnectPluginBundleV1 {
  const source = `
const log = globalThis.__connectClientUploadLog ??= [];
export default {
  activate(context) {
    log.push("bundle-activate:${version}");
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "client-upload",
      create() {
        return {
          modes: [],
          async prepare() { log.push("prepare:${version}"); },
          async start() { throw new Error("not exercised"); }
        };
      }
    });
    ${failActivation ? 'throw new Error("uploaded candidate activation failed");' : ""}
    return async () => { log.push("bundle-dispose:${version}"); };
  }
};`.trim();
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId,
      version,
      dependencies: [
        { type: "host", id: "runtime-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "runtime",
          type: "runtime",
          family: "client-upload",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}

function deferredCodexBundle(pluginId: string): ConnectPluginBundleV1 {
  const source = `
import { existsSync } from "node:fs";
const log = globalThis.__connectDeferredProviderLog ??= [];
export default {
  activate(context) {
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "codex",
      create(configuration) {
        log.push("create");
        const executable = configuration.executablePathOverride;
        if (!existsSync(executable)) {
          throw new Error(\`Failed to inspect configured Codex executable \${executable}\`);
        }
        return {
          modes: ["read-only", "workspace-write"],
          modesFor() {
            log.push("modes");
            return ["read-only", "workspace-write"];
          },
          async start() { throw new Error("not exercised"); }
        };
      }
    });
  }
};`.trim();
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId,
      version: "1.0.0",
      dependencies: [
        { type: "host", id: "runtime-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "runtime",
          type: "runtime",
          family: "codex",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: {
            type: "object",
            properties: { executablePathOverride: { type: "string", minLength: 1 } },
            required: ["executablePathOverride"],
            additionalProperties: false,
          },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}

async function uploadPlugin(
  fetchHandler: ClientHttpServerOptions["fetch"],
  origin: string,
  fileName: string,
  bundle: ConnectPluginBundleV1,
): Promise<Response> {
  const form = new FormData();
  form.set("bundle", new File([JSON.stringify(bundle)], fileName));
  return await request(fetchHandler, origin, "/client/v1/plugins/upload", { method: "POST", body: form });
}

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
    activationGeneration: 1,
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
