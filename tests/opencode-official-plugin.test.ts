import { describe, expect, it, mock } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, GlobalEvent, Project, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import { defaultConfig, saveConfig } from "../src/config";
import { createPluginAgentBinding } from "../src/plugin/binding";
import { ConnectPluginHost } from "../src/plugin/host";
import {
  probeCompatibleOpenCodeExecutable,
  requireCompatibleOpenCodeExecutable,
} from "../src/plugin/official/opencode-compatibility";
import descriptor from "../src/plugin/official/opencode-descriptor";
import { createOpenCodeOfficialPluginEntry } from "../src/plugin/official/opencode-entry";
import {
  OPENCODE_BINDING_CONFIGURATION_SCHEMA,
  OPENCODE_OFFICIAL_CAPABILITY_ID,
  OPENCODE_OFFICIAL_PLUGIN_ID,
} from "../src/plugin/official/opencode-manifest";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  type ConnectPluginContext,
  type ConnectPluginEntry,
  type ConnectPluginRuntimeProvider,
} from "../src/plugin/sdk";
import type { OpenCodeServerClient } from "../src/runtime/opencode-server";
import { OPENCODE_SDK_VERSION } from "../src/runtime/opencode-version";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";

const FIXTURE_VERSION = OPENCODE_SDK_VERSION;

describe("official OpenCode Runtime Plugin", () => {
  it("builds a self-contained target artifact and separately integrity-protected probe", async () => {
    const built = await buildOfficialPlugin(descriptor, { target: "test-target", write: false });

    expect(built.bundle.manifest).toMatchObject({
      pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
      capabilities: [
        {
          id: OPENCODE_OFFICIAL_CAPABILITY_ID,
          type: "runtime",
          family: "opencode",
          configurationSchema: OPENCODE_BINDING_CONFIGURATION_SCHEMA,
        },
      ],
      artifacts: [
        { target: "test-target", entry: "artifacts/test-target.mjs", integrity: expect.stringMatching(/^sha256-/u) },
      ],
      probe: { entry: "probe.mjs", integrity: expect.stringMatching(/^sha256-/u) },
    });
    expect(Object.keys(built.bundle.files).sort()).toEqual(["artifacts/test-target.mjs", "probe.mjs"]);
    expect(built.bundle.files["artifacts/test-target.mjs"]?.content).not.toMatch(
      /from\s+["'](?:\.\.?\/|@opencode-ai\/sdk)/u,
    );
    expect(built.bundle.files["probe.mjs"]?.content).not.toContain("opencode-adapter");
  });

  it("accepts arbitrary parseable versions while executable and malformed-output failures remain closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-opencode-probe-"));
    const versions = ["1.18.16", "7.42.3", "2.0.0-beta.3+darwin.arm64"] as const;
    const executables = await Promise.all(
      versions.map(async (version) => ({
        version,
        path: await fakeExecutable(directory, `opencode-${version}`, version),
      })),
    );
    const malformed = await fakeExecutable(directory, "malformed", "OpenCode development build");
    const commandFailure = await fakeFailingExecutable(directory, "command-failure");
    const provider = await activateProvider(createOpenCodeOfficialPluginEntry());

    for (const candidate of executables) {
      await expect(
        probeCompatibleOpenCodeExecutable({
          platform: process.platform,
          arch: process.arch,
          findExecutable: async () => candidate.path,
        }),
      ).resolves.toEqual({
        detected: true,
        compatible: true,
        path: candidate.path,
        version: candidate.version,
      });
      expect(requireCompatibleOpenCodeExecutable(candidate.path, { PATH: directory })).toEqual(candidate);
      expect(() => provider.create({ executablePathOverride: candidate.path })).not.toThrow();
    }
    await expect(
      probeCompatibleOpenCodeExecutable({
        platform: process.platform,
        arch: process.arch,
        findExecutable: async () => malformed,
      }),
    ).resolves.toMatchObject({
      detected: true,
      compatible: false,
      path: malformed,
      detail: expect.stringContaining("Failed to read OpenCode version"),
    });
    expect(() => requireCompatibleOpenCodeExecutable(malformed, { PATH: directory })).toThrow(
      "Failed to read OpenCode version",
    );
    await expect(
      probeCompatibleOpenCodeExecutable({
        platform: process.platform,
        arch: process.arch,
        findExecutable: async () => commandFailure,
      }),
    ).resolves.toMatchObject({
      detected: true,
      compatible: false,
      path: commandFailure,
      detail: expect.stringContaining("exited with code 17"),
    });
    expect(() => requireCompatibleOpenCodeExecutable(commandFailure, { PATH: directory })).toThrow(
      "exited with code 17",
    );
    await expect(
      probeCompatibleOpenCodeExecutable({
        platform: process.platform,
        arch: process.arch,
        findExecutable: async () => null,
      }),
    ).resolves.toMatchObject({ detected: false, compatible: false });
    expect(() => requireCompatibleOpenCodeExecutable(join(directory, "missing-opencode"), { PATH: directory })).toThrow(
      "could not be started",
    );
    expect(() => requireCompatibleOpenCodeExecutable("  ", { PATH: directory })).toThrow("must not be empty");
  });

  it("creates independent managed server, cache, state, and close lifecycle per Binding", async () => {
    const closes = new Map<string, number>();
    const createServer = mock(async (binding: { env?: Record<string, string> }) => {
      const instance = binding.env?.INSTANCE;
      if (!instance) throw new Error("missing test instance");
      return fakeOpenCodeClient(instance, closes);
    });
    const provider = await activateProvider(
      createOpenCodeOfficialPluginEntry({
        requireExecutable: () => ({ path: "/opt/opencode", version: FIXTURE_VERSION }),
        runtimeAdapter: { createServer },
      }),
    );
    const alpha = provider.create({ env: { INSTANCE: "alpha" } });
    const beta = provider.create({ env: { INSTANCE: "beta" } });

    await Promise.all([alpha.prepare?.(), beta.prepare?.()]);
    await expect(alpha.discoverAllThreads?.()).resolves.toEqual([
      expect.objectContaining({ runtimeThreadId: "alpha-session", workingDirectory: "/repo/alpha" }),
    ]);
    await expect(beta.discoverAllThreads?.()).resolves.toEqual([
      expect.objectContaining({ runtimeThreadId: "beta-session", workingDirectory: "/repo/beta" }),
    ]);
    expect(createServer).toHaveBeenCalledTimes(2);

    await alpha.close?.();
    expect(closes.get("alpha")).toBe(1);
    await expect(beta.discoverAllThreads?.()).resolves.toHaveLength(1);
    await beta.close?.();
    expect(closes.get("alpha")).toBe(1);
    expect(closes.get("beta")).toBe(1);
  });

  it("installs, updates, disables, enables, and removes the built Bundle through exact provider references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-opencode-official-management-"));
    const configPath = join(directory, "config.json");
    const sourcePath = join(directory, "opencode.connect-plugin");
    const config = defaultConfig();
    await saveConfig(config, configPath);
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, () => undefined);
    const v1 = await buildOfficialPlugin(descriptor, { write: false });
    const v2 = await buildOfficialPlugin(
      { ...descriptor, manifest: { ...descriptor.manifest, version: `${descriptor.manifest.version}.1` } },
      { write: false },
    );
    await writeFile(sourcePath, `${JSON.stringify(v1.bundle)}\n`);

    await expect(host.install({ source: `local:${sourcePath}` })).resolves.toMatchObject({
      pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
      status: "active",
    });
    const exactBinding = createPluginAgentBinding({
      runtimeFamily: "opencode",
      pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
      capabilityId: OPENCODE_OFFICIAL_CAPABILITY_ID,
      configuration: { executablePathOverride: join(directory, "missing-opencode") },
    });
    await expect(registry.prepare(exactBinding)).rejects.toThrow("could not be started");
    await expect(
      registry.prepare({
        ...exactBinding,
        runtime: { ...exactBinding.runtime, capabilityId: "other" },
      }),
    ).rejects.toThrow("no Runtime Adapter registered for provider");

    await writeFile(sourcePath, `${JSON.stringify(v2.bundle)}\n`);
    await expect(host.update(OPENCODE_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({
      version: v2.bundle.manifest.version,
      status: "active",
    });
    await expect(host.disable(OPENCODE_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({ status: "disabled" });
    await expect(registry.prepare(exactBinding)).rejects.toThrow("no Runtime Adapter registered for provider");
    await expect(host.enable(OPENCODE_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({ status: "active" });
    await expect(host.remove(OPENCODE_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({
      pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
    });
    await expect(host.list()).resolves.toEqual([]);
    await host.close();
  });
});

async function fakeExecutable(directory: string, name: string, version: string): Promise<string> {
  const path = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  const source =
    process.platform === "win32" ? `@echo off\r\necho ${version}\r\n` : `#!/bin/sh\nprintf '${version}\\n'\n`;
  await writeFile(path, source);
  if (process.platform !== "win32") await chmod(path, 0o700);
  return path;
}

async function fakeFailingExecutable(directory: string, name: string): Promise<string> {
  const path = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  const source =
    process.platform === "win32"
      ? "@echo off\r\necho probe failed 1>&2\r\nexit /b 17\r\n"
      : "#!/bin/sh\nprintf 'probe failed\\n' >&2\nexit 17\n";
  await writeFile(path, source);
  if (process.platform !== "win32") await chmod(path, 0o700);
  return path;
}

async function activateProvider(entry: ConnectPluginEntry) {
  let provider: ConnectPluginRuntimeProvider | undefined;
  const context: ConnectPluginContext = {
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    installationConfiguration: {},
    hostCapabilities: {
      get: () => ({
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
        register(value) {
          if ("family" in value) provider = value;
        },
      }),
    },
  };
  await entry.activate(context);
  if (!provider) throw new Error("OpenCode provider was not registered");
  return provider;
}

function fakeOpenCodeClient(instance: string, closes: Map<string, number>): OpenCodeServerClient {
  const session: Session = {
    id: `${instance}-session`,
    slug: `${instance}-session`,
    projectID: `${instance}-project`,
    directory: `/repo/${instance}`,
    title: instance,
    version: FIXTURE_VERSION,
    time: { created: 1, updated: 1 },
  };
  return {
    version: FIXTURE_VERSION,
    async health() {
      return { healthy: true, version: FIXTURE_VERSION };
    },
    async listProjects(): Promise<Project[]> {
      return [];
    },
    async listAgents(): Promise<Agent[]> {
      return [];
    },
    async listCommands() {
      return [];
    },
    async listProviders(): Promise<{ all: Provider[]; connected: string[]; default: Record<string, string> }> {
      return { all: [], connected: [], default: {} };
    },
    async listSessions() {
      return [session];
    },
    async getSession() {
      return session;
    },
    async createSession() {
      return session;
    },
    async deleteSession() {
      return true;
    },
    async sessionStatus() {
      return {};
    },
    async messages() {
      return [];
    },
    async promptAsync() {},
    async runCommand() {},
    async abortSession() {
      return true;
    },
    async *events(signal: AbortSignal, onConnected?: () => void): AsyncIterable<GlobalEvent> {
      onConnected?.();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    async replyPermission() {
      return true;
    },
    async replyQuestion() {
      return true;
    },
    async rejectQuestion() {
      return true;
    },
    async close() {
      closes.set(instance, (closes.get(instance) ?? 0) + 1);
    },
  };
}
