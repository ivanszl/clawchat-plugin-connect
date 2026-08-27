import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { buildOfficialPlugin, officialPluginIntegrityReport } from "../scripts/build-official-plugins";
import type {
  ConnectPluginContext,
  ConnectPluginManagedWebAppAcquireContext,
  ConnectPluginManagedWebAppProvider,
} from "../src/plugin/sdk";
import connectClientDescriptor from "../src/plugin/official/connect-client-descriptor";
import { createConnectClientOfficialPluginEntry } from "../src/plugin/official/connect-client-entry";
import {
  CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
  CONNECT_CLIENT_MANAGED_WEB_APP_REF,
  CONNECT_CLIENT_PLUGIN_ID,
  CONNECT_CLIENT_SUPPORTED_RUNTIMES,
} from "../src/plugin/official/connect-client-manifest";

const activationGeneration = 7;
const acquireContext: ConnectPluginManagedWebAppAcquireContext = {
  activationGeneration,
  pluginId: CONNECT_CLIENT_PLUGIN_ID,
  capabilityId: CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
  bindingId: "binding-a",
  runtime: { pluginId: "clawling.runtime.codex", capabilityId: "codex" },
  installationConfiguration: {},
  configuration: {},
  runtimeConfiguration: {},

  instanceKey: `${CONNECT_CLIENT_PLUGIN_ID}/${CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID}/${activationGeneration}`,
};
function requireRegisteredProvider(
  provider: ConnectPluginManagedWebAppProvider | null,
): ConnectPluginManagedWebAppProvider {
  if (!provider) throw new Error("Connect Client provider was not registered");
  return provider;
}

describe("official Connect Client Managed Web App", () => {
  it("declares only the three exact compatible Runtime capabilities", () => {
    expect(connectClientDescriptor.manifest.pluginId).toBe(CONNECT_CLIENT_PLUGIN_ID);
    expect(connectClientDescriptor.manifest.capabilities).toEqual([
      expect.objectContaining({
        id: CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
        type: "managed-web-app",
        nativeRuntimeCapabilityIds: [],
        compatibleRuntimes: CONNECT_CLIENT_SUPPORTED_RUNTIMES,
      }),
    ]);
    expect(connectClientDescriptor.assetDirectories).toEqual([
      {
        entryPrefix: "client",
        sourceDirectory: "dist/client",
        integrityManifestEntry: "client-assets.json",
      },
    ]);
  });

  it("integrity-covers the complete built browser asset graph", async () => {
    const built = await buildOfficialPlugin(connectClientDescriptor, { write: false });
    const manifestFile = built.bundle.files["client-assets.json"];
    if (!manifestFile) throw new Error("Connect Client asset integrity manifest is missing");
    const manifestBytes =
      manifestFile.encoding === "utf8"
        ? manifestFile.content
        : Buffer.from(manifestFile.content, "base64").toString("utf8");
    const integrities = JSON.parse(manifestBytes) as Record<string, string>;
    const clientEntries = Object.keys(built.bundle.files)
      .filter((entry) => entry.startsWith("client/"))
      .sort();
    expect(Object.keys(integrities).sort()).toEqual(clientEntries);
    for (const entry of clientEntries) {
      const file = built.bundle.files[entry];
      if (!file) throw new Error(`Connect Client asset is missing: ${entry}`);
      const bytes =
        file.encoding === "utf8" ? Buffer.from(file.content, "utf8") : Buffer.from(file.content, "base64");
      expect(integrities[entry]).toBe(`sha256-${createHash("sha256").update(bytes).digest("base64")}`);
    }
  });

  it("reports exact entry, browser graph, and integrity-manifest SRI for release pinning", async () => {
    const built = await buildOfficialPlugin(connectClientDescriptor, { write: false });
    const report = officialPluginIntegrityReport([built]);
    expect(report).toEqual([
      {
        pluginId: CONNECT_CLIENT_PLUGIN_ID,
        version: built.bundle.manifest.version,
        target: built.target,
        filename: built.filename,
        artifactIntegrity: built.bundle.manifest.artifacts[0]?.integrity,
        fileIntegrities: expect.objectContaining({
          [`artifacts/${built.target}.mjs`]: built.bundle.manifest.artifacts[0]?.integrity,
          "client-assets.json": expect.stringMatching(/^sha256-/u),
          "client/index.html": expect.stringMatching(/^sha256-/u),
        }),
      },
    ]);
    expect(Object.keys(report[0]?.fileIntegrities ?? {}).some((entry) => entry.startsWith("dist/client"))).toBe(
      false,
    );
  });

  it("acquires and releases a real loopback upstream through the exact generation facade", async () => {
    let provider: ConnectPluginManagedWebAppProvider | null = null;
    let stopAttempts = 0;
    const stop = mock(async () => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("Client stop failed");
    });
    const verifyAssets = mock(async () => undefined);
    const startServer = mock(async () => ({
      origin: "http://127.0.0.1:47823",
      retireBindings: async () => undefined,
      stop,
    }));
    const entry = createConnectClientOfficialPluginEntry({
      assetsPath: "/installed/client",
      assetIntegrityManifestPath: "/installed/client-assets.json",
      verifyAssets,
      startServer,
      resolveHostFacade: () => ({
        scope: { managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF, activationGeneration },
        applicationPort: {} as never,
      }),
    });
    entry.activate({
      activationGeneration,
      interfaceVersion: "1",
      installationConfiguration: {},
      hostCapabilities: {
        get(id: string) {
          if (id !== "managed-web-app-provider") throw new Error(`Unexpected Host capability ${id}`);
          return {
            interfaceVersion: "1",
            register(candidate: ConnectPluginManagedWebAppProvider) {
              provider = candidate;
            },
          };
        },
      },
    } as unknown as ConnectPluginContext);

    const registeredProvider = requireRegisteredProvider(provider);
    expect(await registeredProvider.instanceKey(acquireContext)).toBe(acquireContext.instanceKey);
    const instance = await registeredProvider.acquire(acquireContext);
    await instance.waitUntilReady();
    expect(instance.upstream).toBe("http://127.0.0.1:47823");
    expect(instance.health()).toBe("ready");
    expect(verifyAssets).toHaveBeenCalledWith("/installed/client", "/installed/client-assets.json");
    await expect(instance.release()).rejects.toThrow("Client stop failed");
    expect(instance.health()).toBe("ready");
    await expect(instance.release()).resolves.toBeUndefined();
    expect(instance.health()).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("rejects a facade from a stale Activation Generation", async () => {
    let provider: ConnectPluginManagedWebAppProvider | null = null;
    const entry = createConnectClientOfficialPluginEntry({
      assetsPath: "/installed/client",
      assetIntegrityManifestPath: "/installed/client-assets.json",
      verifyAssets: async () => undefined,
      resolveHostFacade: () => ({
        scope: { managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF, activationGeneration: activationGeneration - 1 },
        applicationPort: {} as never,
      }),
    });
    entry.activate({
      activationGeneration,
      interfaceVersion: "1",
      installationConfiguration: {},
      hostCapabilities: {
        get: () => ({
          interfaceVersion: "1",
          register(candidate: ConnectPluginManagedWebAppProvider) {
            provider = candidate;
          },
        }),
      },
    } as unknown as ConnectPluginContext);
    const registeredProvider = requireRegisteredProvider(provider);
    await expect(registeredProvider.acquire(acquireContext)).rejects.toThrow("scope does not match");
  });
});
