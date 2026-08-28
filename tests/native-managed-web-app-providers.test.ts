import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepSeekHarnessOfficialPluginEntry } from "../src/plugin/official/deepseek-harness-entry";
import {
  DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
  DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
  DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
} from "../src/plugin/official/deepseek-harness-manifest";
import { createOpenCodeOfficialPluginEntry } from "../src/plugin/official/opencode-entry";
import {
  OPENCODE_OFFICIAL_CAPABILITY_ID,
  OPENCODE_OFFICIAL_PLUGIN_ID,
  OPENCODE_WEB_APP_CAPABILITY_ID,
} from "../src/plugin/official/opencode-manifest";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  type ConnectPluginContext,
  type ConnectPluginEntry,
  type ConnectPluginManagedWebAppInstance,
  type ConnectPluginManagedWebAppInstanceContext,
  type ConnectPluginManagedWebAppProvider,
  type ConnectPluginRuntimeProvider,
  type ManagedWebAppHealth,
} from "../src/plugin/sdk";
import type { DeepSeekHarnessRuntimeAdapter } from "../src/runtime/deepseek-harness-adapter";

describe("native Managed Web App providers", () => {
  it("keys DSH Web by exact executable, canonical Home, and canonical Web environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "connect-dsh-web-provider-"));
    const firstExecutable = join(root, "dsh-one");
    const secondExecutable = join(root, "dsh-two");
    const sharedHome = join(root, "home");
    const isolatedHome = join(root, "other-home");
    await Promise.all([
      writeFile(firstExecutable, "first"),
      writeFile(secondExecutable, "second"),
      mkdir(sharedHome),
      mkdir(isolatedHome),
    ]);
    const starts: Array<{ executable: string; executableArguments: readonly string[]; home: string }> = [];
    const instances: FakeManagedWebApp[] = [];
    const providers = await activateProviders(
      createDeepSeekHarnessOfficialPluginEntry({
        webApp: {
          probeExecutable: (configured) => ({
            path: configured ?? firstExecutable,
            executableArguments: ["--yes", "@deepseek-ai/dsh"],
          }),
          async start(options) {
            starts.push({
              executable: options.executable,
              executableArguments: options.executableArguments ?? [],
              home: options.home,
            });
            const instance = new FakeManagedWebApp(`http://127.0.0.1:${42000 + instances.length}`);
            instances.push(instance);
            return instance;
          },
        },
      }),
    );
    const web = providers.web.get(DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID);
    if (!web) throw new Error("DSH Web provider was not registered");
    const alpha = managedContext(
      DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
      DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      "alpha",
      {
        executablePathOverride: firstExecutable,
        homePath: sharedHome,
        env: { WEB_MODE: "shared", DSH_WEB_TOKEN: "credential-value" },
      },
    );
    const same = managedContext(
      DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
      DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      "same",
      {
        executablePathOverride: firstExecutable,
        homePath: sharedHome,
        env: { DSH_WEB_TOKEN: "credential-value", WEB_MODE: "shared" },
      },
    );
    const differentEnvironment = managedContext(
      DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
      DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      "different-environment",
      {
        executablePathOverride: firstExecutable,
        homePath: sharedHome,
        env: { DSH_WEB_TOKEN: "different-credential", WEB_MODE: "shared" },
      },
    );
    const isolatedHomeContext = managedContext(
      DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
      DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      "isolated-home",
      { executablePathOverride: firstExecutable, homePath: isolatedHome },
    );
    const conflict = managedContext(
      DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
      DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      "conflict",
      { executablePathOverride: secondExecutable, homePath: sharedHome },
    );
    const alphaKey = await web.instanceKey(alpha);
    expect(await web.instanceKey(same)).toBe(alphaKey);
    expect(alphaKey).not.toContain("credential-value");
    const differentEnvironmentKey = await web.instanceKey(differentEnvironment);
    expect(differentEnvironmentKey).not.toBe(alphaKey);
    expect(differentEnvironmentKey).not.toContain("different-credential");
    expect(await web.instanceKey(isolatedHomeContext)).not.toBe(alphaKey);

    const alphaApp = await web.acquire({ ...alpha, instanceKey: alphaKey });
    const differentEnvironmentApp = await web.acquire({
      ...differentEnvironment,
      instanceKey: differentEnvironmentKey,
    });
    const conflictKey = await web.instanceKey(conflict);
    await expect(web.acquire({ ...conflict, instanceKey: conflictKey })).rejects.toThrow(
      "already active under a different DeepSeek Harness executable identity",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual({
      executable: await realpath(firstExecutable),
      executableArguments: ["--yes", "@deepseek-ai/dsh"],
      home: await realpath(sharedHome),
    });
    await Promise.all([alphaApp.release(), differentEnvironmentApp.release()]);
    const conflictApp = await web.acquire({ ...conflict, instanceKey: conflictKey });
    await conflictApp.release();
  });

  it("uses the configured DSH executable for Web before any package launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "connect-dsh-web-configured-"));
    const executable = join(root, "dsh");
    const home = join(root, "home");
    await Promise.all([writeFile(executable, "native"), mkdir(home)]);
    const starts: Array<{
      executable: string;
      executableArguments: readonly string[];
      home: string;
    }> = [];
    const providers = await activateProviders(
      createDeepSeekHarnessOfficialPluginEntry({
        webApp: {
          async start(options) {
            starts.push({
              executable: options.executable,
              executableArguments: options.executableArguments ?? [],
              home: options.home,
            });
            return new FakeManagedWebApp("http://127.0.0.1:43101");
          },
        },
      }),
    );
    const web = providers.web.get(DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID);
    if (!web) throw new Error("DSH Web provider was not registered");
    const context = managedContext(
      DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
      DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      "configured",
      { executablePathOverride: executable, homePath: home },
    );
    const instanceKey = await web.instanceKey(context);
    const app = await web.acquire({ ...context, instanceKey });

    expect(starts).toEqual([
      {
        executable: await realpath(executable),
        executableArguments: [],
        home: await realpath(home),
      },
    ]);
    await app.release();
  });

  it("canonicalizes symlinks and rejects non-files through one native executable contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "connect-native-executable-identity-"));
    const executable = join(root, "native-executable");
    const executableAlias = join(root, "native-executable-alias");
    const executableDirectory = join(root, "not-an-executable");
    const home = join(root, "dsh-home");
    await writeFile(executable, "native");
    await symlink(executable, executableAlias);
    await Promise.all([mkdir(executableDirectory), mkdir(home)]);

    const dshProviders = await activateProviders(
      createDeepSeekHarnessOfficialPluginEntry({
        webApp: {
          probeExecutable: (configured) => ({ path: configured ?? executable }),
          start: async () => new FakeManagedWebApp("http://127.0.0.1:43101"),
        },
      }),
    );
    const openCodeProviders = await activateProviders(
      createOpenCodeOfficialPluginEntry({
        requireExecutable: (configured) => ({
          path: configured ?? executable,
          version: "1.18.16",
        }),
      }),
    );
    const dshWeb = dshProviders.web.get(DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID);
    const openCodeWeb = openCodeProviders.web.get(OPENCODE_WEB_APP_CAPABILITY_ID);
    if (!dshWeb || !openCodeWeb) throw new Error("Native Web providers were not registered");

    const dshContext = (path: string) =>
      managedContext(
        DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
        DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
        DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
        "dsh",
        { executablePathOverride: path, homePath: home },
      );
    const openCodeContext = (path: string) =>
      managedContext(
        OPENCODE_OFFICIAL_PLUGIN_ID,
        OPENCODE_WEB_APP_CAPABILITY_ID,
        OPENCODE_OFFICIAL_CAPABILITY_ID,
        "opencode",
        { executablePathOverride: path },
      );

    expect(await dshWeb.instanceKey(dshContext(executableAlias))).toBe(
      await dshWeb.instanceKey(dshContext(executable)),
    );
    expect(await openCodeWeb.instanceKey(openCodeContext(executableAlias))).toBe(
      await openCodeWeb.instanceKey(openCodeContext(executable)),
    );
    await expect(Promise.resolve().then(() => dshWeb.instanceKey(dshContext(executableDirectory)))).rejects.toThrow(
      "DeepSeek Harness executable is not a regular file:",
    );
    await expect(
      Promise.resolve().then(() => openCodeWeb.instanceKey(openCodeContext(executableDirectory))),
    ).rejects.toThrow("OpenCode executable is not a regular file:");
  });

  it("keeps DSH Runtime and Web health and shutdown independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "connect-dsh-web-independent-"));
    const executable = join(root, "dsh");
    const home = join(root, "home");
    await writeFile(executable, "dsh");
    await mkdir(home);
    let runtimePrepares = 0;
    let runtimeCloses = 0;
    const nativeApp = new FakeManagedWebApp("http://127.0.0.1:43001");
    const adapter = {
      kind: "deepseek-harness",
      modes: [],
      async prepare() {
        runtimePrepares += 1;
      },
      async start() {
        throw new Error("not exercised");
      },
      async close() {
        runtimeCloses += 1;
      },
    } as unknown as DeepSeekHarnessRuntimeAdapter;
    const providers = await activateProviders(
      createDeepSeekHarnessOfficialPluginEntry({
        createAdapter: () => adapter,
        webApp: {
          probeExecutable: () => ({ path: executable }),
          start: async () => nativeApp,
        },
      }),
    );
    const runtime = providers.runtime.get(DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID);
    const web = providers.web.get(DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID);
    if (!runtime || !web) throw new Error("DSH providers were not registered");
    const runtimeAdapter = runtime.create(
      { executablePathOverride: executable, homePath: home },
      { activationGeneration: 1 },
    );
    const context = managedContext(
      DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
      DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      "binding",
      { executablePathOverride: executable, homePath: home },
    );
    const app = await web.acquire({ ...context, instanceKey: await web.instanceKey(context) });
    nativeApp.exit(new Error("web failed"));
    expect(app.health()).toBe("error");
    await runtimeAdapter.prepare?.();
    expect(runtimePrepares).toBe(1);
    expect(runtimeCloses).toBe(0);
    await app.release();
    expect(runtimeCloses).toBe(0);
    await runtimeAdapter.close?.();
    expect(runtimeCloses).toBe(1);
  });

  it("selects and starts exact OpenCode Web independently from the Runtime Adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "connect-opencode-web-provider-"));
    const executable = join(root, "opencode");
    await writeFile(executable, "opencode");
    const nativeApp = new FakeManagedWebApp("http://127.0.0.1:43130");
    let startedExecutable: { path: string; version: string } | undefined;
    const providers = await activateProviders(
      createOpenCodeOfficialPluginEntry({
        requireExecutable: () => ({ path: executable, version: "1.18.16" }),
        startWebApp: async (options) => {
          startedExecutable = options.executable;
          return nativeApp;
        },
      }),
    );
    const web = providers.web.get(OPENCODE_WEB_APP_CAPABILITY_ID);
    if (!web) throw new Error("OpenCode Web provider was not registered");
    const context = managedContext(
      OPENCODE_OFFICIAL_PLUGIN_ID,
      OPENCODE_WEB_APP_CAPABILITY_ID,
      OPENCODE_OFFICIAL_CAPABILITY_ID,
      "binding",
      { executablePathOverride: executable },
    );
    const key = await web.instanceKey(context);
    const app = await web.acquire({ ...context, instanceKey: key });
    expect(startedExecutable).toEqual({ path: await realpath(executable), version: "1.18.16" });
    expect(app.upstream).toBe("http://127.0.0.1:43130");
    const runtime = providers.runtime.get(OPENCODE_OFFICIAL_CAPABILITY_ID);
    if (!runtime) throw new Error("OpenCode Runtime provider was not registered");
    const runtimeAdapter = runtime.create({ executablePathOverride: executable }, { activationGeneration: 1 });
    expect(runtimeAdapter.modes).toBeDefined();
    await runtimeAdapter.close?.();

    expect(app.health()).toBe("ready");
    await app.release();
    expect(nativeApp.releases).toBe(1);
  });
});

async function activateProviders(entry: ConnectPluginEntry): Promise<{
  runtime: Map<string, ConnectPluginRuntimeProvider>;
  web: Map<string, ConnectPluginManagedWebAppProvider>;
}> {
  const runtime = new Map<string, ConnectPluginRuntimeProvider>();
  const web = new Map<string, ConnectPluginManagedWebAppProvider>();
  const context = {
    activationGeneration: 1,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    installationConfiguration: {},
    hostCapabilities: {
      get(id: string) {
        if (id === "runtime-provider") {
          return {
            interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
            register(provider: ConnectPluginRuntimeProvider) {
              runtime.set(provider.capabilityId, provider);
            },
          };
        }
        if (id === "managed-web-app-provider") {
          return {
            interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
            register(provider: ConnectPluginManagedWebAppProvider) {
              web.set(provider.capabilityId, provider);
            },
          };
        }
        throw new Error(`Unexpected Host Capability ${id}`);
      },
    },
  } as unknown as ConnectPluginContext;
  await entry.activate(context);
  return { runtime, web };
}

function managedContext(
  pluginId: string,
  capabilityId: string,
  runtimeCapabilityId: string,
  bindingId: string,
  runtimeConfiguration: Readonly<Record<string, unknown>>,
): ConnectPluginManagedWebAppInstanceContext {
  return {
    activationGeneration: 1,
    pluginId,
    capabilityId,
    bindingId,
    runtime: { pluginId, capabilityId: runtimeCapabilityId },
    installationConfiguration: {},
    configuration: {},
    runtimeConfiguration,
  };
}

class FakeManagedWebApp implements ConnectPluginManagedWebAppInstance {
  private currentHealth: ManagedWebAppHealth = "ready";
  private readonly healthListeners = new Set<(health: ManagedWebAppHealth) => void>();
  private readonly exitListeners = new Set<(error?: unknown) => void>();
  releases = 0;

  constructor(readonly upstream: string) {}

  async waitUntilReady(): Promise<void> {}

  health(): ManagedWebAppHealth {
    return this.currentHealth;
  }

  onHealthChange(listener: (health: ManagedWebAppHealth) => void) {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  onExit(listener: (error?: unknown) => void) {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async release(): Promise<void> {
    this.releases += 1;
  }

  exit(error?: unknown): void {
    this.currentHealth = error ? "error" : "stopped";
    for (const listener of this.healthListeners) listener(this.currentHealth);
    for (const listener of this.exitListeners) listener(error);
  }
}
