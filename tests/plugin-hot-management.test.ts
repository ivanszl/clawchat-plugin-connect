import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { createPluginAgentBinding } from "../src/plugin/binding";
import { ConnectPluginHost } from "../src/plugin/host";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectPluginBundleV1,
} from "../src/plugin/sdk";
import { currentConnectPluginTarget, pluginInstallationPaths } from "../src/plugin/store";
import { ProjectCatalog } from "../src/projects/projects";
import type { TurnTarget } from "../src/projects/session-continuity";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { SessionQueue } from "../src/runtime/session-queue";
import { SessionTurnExecutor } from "../src/runtime/session-turn-executor";

function hotBundle(pluginId: string, version: string, failExposure = false): ConnectPluginBundleV1 {
  const source = `
const log = globalThis.__connectHotPluginLog ??= [];
export default {
  async activate(context) {
    const runtime = context.hostCapabilities.get("runtime-provider");
    const exposure = context.hostCapabilities.get("exposure-provider");
    runtime.register({
      capabilityId: "runtime",
      family: "hot",
      create() {
        return {
          modes: ["managed"],
          async prepare() { log.push("prepare:${pluginId}@${version}"); },
          async start() { throw new Error("not exercised"); },
          async close() { log.push("runtime-close:${pluginId}@${version}"); }
        };
      }
    });
    exposure.register({
      capabilityId: "exposure",
      async activate() {
        log.push("exposure-activate:${pluginId}@${version}");
        return async () => { log.push("exposure-dispose:${pluginId}@${version}"); };
      }
    });
    ${failExposure ? `throw new Error("candidate exposure failed");` : ""}
    return async () => { log.push("bundle-dispose:${pluginId}@${version}"); };
  }
};
`.trim();
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
        { type: "host", id: "exposure-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "runtime",
          type: "runtime",
          family: "hot",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
        {
          id: "exposure",
          type: "exposure",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}
interface LifecycleBundleOptions {
  runtimeSchema?: Record<string, unknown>;
  includeRuntime?: boolean;
  failAdapterClose?: boolean;
  exposureFailure?: boolean;
}

function lifecycleBundle(
  pluginId: string,
  version: string,
  options: LifecycleBundleOptions = {},
): ConnectPluginBundleV1 {
  const includeRuntime = options.includeRuntime ?? true;
  const source = `
const log = globalThis.__connectPluginLifecycleLog ??= [];
export default {
  async activate(context) {
    log.push("bundle-activate:${version}");
    ${
      includeRuntime
        ? `context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "hot",
      create() {
        log.push("adapter-create:${version}");
        return {
          modes: [],
          async prepare() { log.push("adapter-prepare:${version}"); },
          async start() {
            log.push("session-start:${version}");
            return {
              async *prompt() {
                log.push("session-prompt:${version}");
                const gate = globalThis.__connectPluginTurnGate;
                if (gate) {
                  gate.started();
                  await gate.wait;
                }
                log.push("session-prompt-complete:${version}");
              },
              async close() { log.push("session-close:${version}"); }
            };
          },
          async close() {
            log.push("adapter-close:${version}");
            ${options.failAdapterClose ? `throw new Error("v1 adapter disposal failed");` : ""}
          }
        };
      }
    });`
        : `context.hostCapabilities.get("exposure-provider").register({
      capabilityId: "replacement-exposure",
      async activate() {
        log.push("exposure-activate:${version}");
        return async () => { log.push("exposure-dispose:${version}"); };
      }
    });`
    }
    ${
      includeRuntime && options.exposureFailure !== undefined
        ? `context.hostCapabilities.get("exposure-provider").register({
      capabilityId: "exposure",
      async activate() {
        log.push("exposure-activate:${version}");
        ${options.exposureFailure ? `throw new Error("candidate exposure activation failed");` : ""}
        return async () => { log.push("exposure-dispose:${version}"); };
      }
    });`
        : ""
    }
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
        {
          type: "host",
          id: includeRuntime ? "runtime-provider" : "exposure-provider",
          interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
        },
        ...(includeRuntime && options.exposureFailure !== undefined
          ? [
              {
                type: "host" as const,
                id: "exposure-provider" as const,
                interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
              },
            ]
          : []),
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        ...(includeRuntime
          ? [
              {
                id: "runtime",
                type: "runtime" as const,
                family: "hot",
                interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
                configurationSchema: options.runtimeSchema ?? { type: "object" },
              },
            ]
          : [
              {
                id: "replacement-exposure",
                type: "exposure" as const,
                interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
                configurationSchema: { type: "object", additionalProperties: false },
              },
            ]),
        ...(includeRuntime && options.exposureFailure !== undefined
          ? [
              {
                id: "exposure",
                type: "exposure" as const,
                interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
                configurationSchema: { type: "object", additionalProperties: false },
              },
            ]
          : []),
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}

async function writeBundle(directory: string, bundle: ConnectPluginBundleV1): Promise<string> {
  const path = join(directory, `${bundle.manifest.pluginId}-${bundle.manifest.version}.connect-plugin`);
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return path;
}

function binding(pluginId: string, bindingId: string) {
  return {
    ...createPluginAgentBinding({
      runtimeFamily: "hot",
      pluginId,
      capabilityId: "runtime",
      configuration: {},
    }),
    env: { CLAWCHAT_CONNECT_AGENT_ID: bindingId },
  };
}

describe("hot Plugin management service", () => {
  it("switches coherent Bundles, rolls failed candidates back, disables/enables, retains/selects, and force-purges exact Bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-plugin-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.hot-plugin";
    const bindingId = "hot-binding";
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: binding(pluginId, bindingId) },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const projects = new ProjectCatalog(store);
    const registry = new RuntimeAdapterRegistry([]);
    const diagnostics: string[] = [];
    const host = new ConnectPluginHost(
      configPath,
      registry,
      (_id, error) => diagnostics.push(error instanceof Error ? error.message : String(error)),
      { config, stateStore: store, projects },
    );
    Reflect.set(globalThis, "__connectHotPluginLog", []);

    const v1 = hotBundle(pluginId, "1.0.0");
    const v2 = hotBundle(pluginId, "2.0.0");
    const v3 = hotBundle(pluginId, "3.0.0", true);
    const unrelated = hotBundle("test.unrelated-plugin", "1.0.0");
    const [sourcePath, unrelatedPath] = await Promise.all([
      writeBundle(directory, v1),
      writeBundle(directory, unrelated),
    ]);

    await expect(host.install({ source: `local:${sourcePath}` })).resolves.toMatchObject({
      version: "1.0.0",
      status: "active",
    });
    await registry.prepare(config.agents[bindingId]!);
    await expect(host.install({ source: `local:${unrelatedPath}` })).resolves.toMatchObject({ status: "active" });
    await registry.prepare(binding("test.unrelated-plugin", "unrelated-binding"));

    await writeFile(sourcePath, `${JSON.stringify(v2, null, 2)}\n`);
    await expect(host.update(pluginId)).resolves.toMatchObject({
      version: "2.0.0",
      status: "active",
      retainedVersions: [{ version: "1.0.0" }],
    });
    await registry.prepare(config.agents[bindingId]!);
    expect(Reflect.get(globalThis, "__connectHotPluginLog")).toContain("runtime-close:test.hot-plugin@1.0.0");

    await writeFile(sourcePath, `${JSON.stringify(v3, null, 2)}\n`);
    await expect(host.update(pluginId)).rejects.toThrow("candidate exposure failed");
    await expect(host.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId, version: "2.0.0", status: "active", error: "candidate exposure failed" }),
        expect.objectContaining({ pluginId: "test.unrelated-plugin", version: "1.0.0", status: "active" }),
      ]),
    );
    await registry.prepare(config.agents[bindingId]!);
    await registry.prepare(binding("test.unrelated-plugin", "unrelated-binding"));
    const failedSource = v3.files["plugin.mjs"]!.content;
    const failedRoot = join(
      pluginInstallationPaths(configPath).store,
      createHash("sha256").update(pluginId).digest("hex"),
      encodeURIComponent("3.0.0"),
      createHash("sha256").update(failedSource).digest("hex"),
    );
    await expect(access(failedRoot)).rejects.toThrow();

    await expect(host.disable(pluginId)).resolves.toMatchObject({ version: "2.0.0", status: "disabled" });
    await expect(registry.prepare(config.agents[bindingId]!)).rejects.toThrow(
      "no Runtime Adapter registered for provider",
    );
    await expect(store.getRuntimeStatus(bindingId)).resolves.toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: expect.stringContaining("disabled"),
    });
    await expect(host.enable(pluginId)).resolves.toMatchObject({ version: "2.0.0", status: "active" });
    await registry.prepare(config.agents[bindingId]!);

    await expect(host.select(pluginId, "1.0.0")).resolves.toMatchObject({
      version: "1.0.0",
      status: "active",
      retainedVersions: [expect.objectContaining({ version: "2.0.0" })],
    });
    await expect(host.remove(pluginId)).rejects.toThrow("required by Agent Bindings");
    await expect(host.remove(pluginId, true)).resolves.toMatchObject({ pluginId, version: "1.0.0" });
    expect(config.agents[bindingId]).toBeUndefined();
    await expect(store.getRuntimeStatus(bindingId)).resolves.toBeNull();
    await expect(host.list()).resolves.toEqual([expect.objectContaining({ pluginId: "test.unrelated-plugin" })]);
    expect(diagnostics).toContain("candidate exposure failed");

    await host.close();
    await store.close();
  });

  it("rejects removed or narrowed dependent Runtime capabilities before activating a candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-dependent-validation-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.dependent-validation";
    const bindingId = "dependent-binding";
    const dependent = { ...binding(pluginId, bindingId), runtimeConfig: { instance: "configured" } };
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      projects: new ProjectCatalog(store),
    });
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0"));
    await host.install({ source: `local:${sourcePath}` });
    await registry.prepare(dependent);

    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0", { includeRuntime: false }))}\n`);
    await expect(host.update(pluginId)).rejects.toThrow("requires missing Runtime capability");
    expect(host.activePluginIds()).toEqual([pluginId]);
    await expect(registry.prepare(dependent)).resolves.toBeUndefined();

    const narrowedSchema = {
      type: "object",
      additionalProperties: false,
      required: ["token"],
      properties: { token: { type: "string" } },
    };
    await writeFile(
      sourcePath,
      `${JSON.stringify(lifecycleBundle(pluginId, "3.0.0", { runtimeSchema: narrowedSchema }))}\n`,
    );
    await expect(host.update(pluginId)).rejects.toThrow("Runtime configuration");
    expect(host.activePluginIds()).toEqual([pluginId]);
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({ pluginId, version: "1.0.0", status: "active" }),
    ]);
    await expect(registry.prepare(dependent)).resolves.toBeUndefined();

    await host.close();
    await store.close();
  });

  it("rolls candidate effects back and keeps v2 Runtime unpublished when the staged lock commit fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-lock-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.lock-failure";
    const bindingId = "lock-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const lockfile = pluginInstallationPaths(configPath).lockfile;
    let sabotageCommit = false;
    let originalLockfile: string | undefined;
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      projects: new ProjectCatalog(store),
      quiesceRuntimeBindings: async (_bindingIds, criticalSection) => {
        await registry.prepare(dependent);
        if (!sabotageCommit) return await criticalSection();
        originalLockfile = await readFile(lockfile, "utf8");
        await rm(lockfile);
        await mkdir(lockfile);
        return await criticalSection();
      },
    });
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0", { exposureFailure: false }));
    await host.install({ source: `local:${sourcePath}` });
    await registry.prepare(dependent);
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0", { exposureFailure: false }))}\n`);

    sabotageCommit = true;
    try {
      await expect(host.update(pluginId)).rejects.toThrow();
    } finally {
      if (originalLockfile !== undefined) {
        await rm(lockfile, { recursive: true });
        await writeFile(lockfile, originalLockfile);
      }
    }
    expect(host.activePluginIds()).toEqual([pluginId]);
    await expect(registry.prepare(dependent)).resolves.toBeUndefined();
    const lockFailureLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(lockFailureLog).not.toContain("adapter-prepare:2.0.0");
    expect(lockFailureLog.indexOf("exposure-activate:2.0.0")).toBeLessThan(
      lockFailureLog.indexOf("exposure-dispose:2.0.0"),
    );

    await host.close();
    await store.close();
  });

  it("releases cached Session handles before disposing v1 and opens v2 on the next Turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-session-release-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.session-release";
    const bindingId = "session-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const executor = new SessionTurnExecutor({
      configPath,
      stateDbPath,
      bindingFor: () => dependent,
      start: async (runtimeBinding, context) => await registry.start(runtimeBinding, context),
      attachRuntimeThread: async () => undefined,
    });
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      projects: new ProjectCatalog(store),
      quiesceRuntimeBindings: async (bindingIds, criticalSection) => {
        await executor.releaseBindings(new Set(bindingIds));
        return await criticalSection();
      },
    });
    const target: TurnTarget = {
      chatId: "chat",
      bindingId,
      sessionId: "session",
      sessionRef: "SESSION1",
      runtimeThreadId: null,
      projectId: null,
      name: null,
      mode: null,
      model: null,
      reasoningEffort: null,
      turnOrigin: "client",
    };
    const input = {
      prompt: "hello",
      workspace: { projectId: null, workingDirectory: directory, skipGitRepoCheck: true },
    };
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0"));
    await host.install({ source: `local:${sourcePath}` });
    await Array.fromAsync(executor.execute(target, input));
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0"))}\n`);

    await host.update(pluginId);
    await Array.fromAsync(executor.execute(target, input));
    const lifecycleLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(lifecycleLog.indexOf("session-close:1.0.0")).toBeLessThan(lifecycleLog.indexOf("adapter-close:1.0.0"));
    expect(lifecycleLog.filter((entry) => entry.startsWith("session-start:"))).toEqual([
      "session-start:1.0.0",
      "session-start:2.0.0",
    ]);

    await executor.close();
    await host.close();
    await store.close();
  });

  it("quiesces dependent Turns across replacement, failure, disable, enable, and removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-quiescence-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.quiescent-plugin";
    const bindingId = "quiescent-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const executor = new SessionTurnExecutor({
      configPath,
      stateDbPath,
      bindingFor: () => dependent,
      start: async (runtimeBinding, context) => await registry.start(runtimeBinding, context),
      attachRuntimeThread: async () => undefined,
    });
    const queue = new SessionQueue({ maxConcurrentTurns: 2 });
    let failQuiescence = false;
    let afterRelease: (() => void) | undefined;
    let quiescenceReached: (() => void) | undefined;
    let quiescenceHold: Promise<void> | undefined;
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      projects: new ProjectCatalog(store),
      quiesceRuntimeBindings: async (bindingIds, criticalSection) => {
        const release = await queue.acquireBindingQuiescence(`Agent Binding ${bindingIds.join(", ")}`);
        try {
          await executor.releaseBindings(new Set(bindingIds));
          afterRelease?.();
          quiescenceReached?.();
          await quiescenceHold;
          if (failQuiescence) throw new Error("quiescence release failed");
          return await criticalSection();
        } finally {
          await release();
        }
      },
    });
    const target: TurnTarget = {
      chatId: "chat",
      bindingId,
      sessionId: "session",
      sessionRef: "SESSION-QUIESCENT",
      runtimeThreadId: null,
      projectId: null,
      name: null,
      mode: null,
      model: null,
      reasoningEffort: null,
      turnOrigin: "client",
    };
    const input = {
      prompt: "hello",
      workspace: { projectId: null, workingDirectory: directory, skipGitRepoCheck: true },
    };
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0"));
    await host.install({ source: `local:${sourcePath}` });

    let markTurnStarted: () => void = () => undefined;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    let finishTurn: () => void = () => undefined;
    const turnWait = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    Reflect.set(globalThis, "__connectPluginTurnGate", { started: markTurnStarted, wait: turnWait });
    const active = queue.submit("session", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await turnStarted;
    const queued = queue.submit("session", async () => {
      throw new Error("queued v1 Turn must not run");
    });
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0"))}\n`);
    let admissionFailure: unknown;
    afterRelease = () => {
      try {
        queue.submit("between-release-and-swap", async () => {
          await Array.fromAsync(executor.execute(target, input));
        });
      } catch (error) {
        admissionFailure = error;
      }
    };

    const updating = host.update(pluginId);
    await expect(queued.completion).rejects.toThrow("Agent Binding");
    expect(() => queue.submit("concurrent", async () => undefined)).toThrow("lifecycle operation");
    expect(Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[]).not.toContain("session-close:1.0.0");
    finishTurn();
    await active.completion;
    await updating;
    expect(admissionFailure).toMatchObject({ message: expect.stringContaining("lifecycle operation") });
    const replacementLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(replacementLog.indexOf("session-prompt-complete:1.0.0")).toBeLessThan(
      replacementLog.indexOf("session-close:1.0.0"),
    );
    expect(replacementLog.indexOf("session-close:1.0.0")).toBeLessThan(replacementLog.indexOf("adapter-close:1.0.0"));
    expect(replacementLog.filter((entry) => entry === "session-start:1.0.0")).toHaveLength(1);

    Reflect.deleteProperty(globalThis, "__connectPluginTurnGate");
    afterRelease = undefined;
    await queue.enqueue("resumed-success", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "3.0.0"))}\n`);
    failQuiescence = true;
    await expect(host.update(pluginId)).rejects.toThrow("quiescence release failed");
    failQuiescence = false;
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({ pluginId, version: "2.0.0", status: "active" }),
    ]);
    await queue.enqueue("resumed-failure", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    expect((Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[]).at(-2)).toBe("session-prompt:2.0.0");

    await host.disable(pluginId);
    const disableLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(disableLog.lastIndexOf("session-close:2.0.0")).toBeLessThan(disableLog.lastIndexOf("adapter-close:2.0.0"));
    const disabledTurn = queue.submit("resumed-disabled", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await expect(disabledTurn.completion).rejects.toThrow("no Runtime Adapter registered");

    let markEnableGateReached: () => void = () => undefined;
    const enableGateReached = new Promise<void>((resolve) => {
      markEnableGateReached = resolve;
    });
    let continueEnable: () => void = () => undefined;
    quiescenceHold = new Promise<void>((resolve) => {
      continueEnable = resolve;
    });
    quiescenceReached = markEnableGateReached;
    const enabling = host.enable(pluginId);
    await enableGateReached;
    expect(() => queue.submit("concurrent-enable", async () => undefined)).toThrow("lifecycle operation");
    continueEnable();
    await enabling;
    quiescenceReached = undefined;
    quiescenceHold = undefined;
    await queue.enqueue("before-remove", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await host.remove(pluginId, true);
    const removeLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(removeLog.lastIndexOf("session-close:2.0.0")).toBeLessThan(removeLog.lastIndexOf("adapter-close:2.0.0"));
    expect(config.agents[bindingId]).toBeUndefined();

    await executor.close();
    await host.close();
    await store.close();
  });

  it("disposes candidate effects and keeps v1 routing and lock active when Exposure activation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-exposure-commit-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.exposure-commit-failure";
    const bindingId = "exposure-failure-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      projects: new ProjectCatalog(store),
    });
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0", { exposureFailure: false }));
    await host.install({ source: `local:${sourcePath}` });
    await registry.prepare(dependent);
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0", { exposureFailure: true }))}\n`);

    await expect(host.update(pluginId)).rejects.toThrow("candidate exposure activation failed");
    expect(host.activePluginIds()).toEqual([pluginId]);
    await expect(registry.prepare(dependent)).resolves.toBeUndefined();
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        version: "1.0.0",
        status: "active",
        error: "candidate exposure activation failed",
      }),
    ]);
    const exposureFailureLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(exposureFailureLog).toContain("bundle-dispose:2.0.0");
    expect(exposureFailureLog).not.toContain("adapter-create:2.0.0");

    await host.close();
    await store.close();
  });

  it("removes v2 and marks the committed Bundle unavailable when post-commit disposal fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-post-commit-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.post-commit-failure";
    const bindingId = "failure-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const diagnostics: string[] = [];
    const host = new ConnectPluginHost(
      configPath,
      registry,
      (_id, error) => diagnostics.push(error instanceof Error ? error.message : String(error)),
      { config, stateStore: store, projects: new ProjectCatalog(store) },
    );
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0", { failAdapterClose: true }));
    await host.install({ source: `local:${sourcePath}` });
    await registry.prepare(dependent);
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0"))}\n`);

    await expect(host.update(pluginId)).rejects.toThrow("v1 adapter disposal failed");
    expect(host.activePluginIds()).toEqual([]);
    await expect(registry.prepare(dependent)).rejects.toThrow("no Runtime Adapter registered for provider");
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        version: "2.0.0",
        status: "error",
        error: "v1 adapter disposal failed",
      }),
    ]);
    await expect(store.getRuntimeStatus(bindingId)).resolves.toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: expect.stringContaining("v1 adapter disposal failed"),
    });
    expect(diagnostics).toContain("v1 adapter disposal failed");

    await host.close();
    await store.close();
  });
});
