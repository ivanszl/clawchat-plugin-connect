import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectPluginHost } from "../src/plugin/host";
import codexDescriptor from "../src/plugin/official/codex-descriptor";
import { createCodexOfficialAdapter } from "../src/plugin/official/codex-entry";
import {
  CODEX_BINDING_CONFIGURATION_SCHEMA,
  CODEX_CAPABILITY_ID,
  CODEX_PLUGIN_ID,
  CODEX_RUNTIME_FAMILY,
} from "../src/plugin/official/codex-manifest";
import type { CodexRuntimeAdapterBinding } from "../src/runtime/codex-adapter";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimeAdapter, ConnectRuntimePrompt } from "../src/runtime/types";
import type { AgentBindingConfig } from "../src/types";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { type AdapterHarness, runtimeAdapterConformance } from "./runtime-adapter-conformance";

const target = `${process.platform}-${process.arch}`;
const fakeCodexExecutable = resolve("tests/fixtures/fake-codex-app-server.ts");
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

const builtCodex = await buildOfficialPlugin(codexDescriptor, { target, write: false });

runtimeAdapterConformance("installed official Codex Plugin", createInstalledCodexHarness);

describe("official Codex Plugin Bundle", () => {
  it("builds a self-contained target artifact with exact integrity", () => {
    expect(builtCodex.bundle.manifest.pluginId).toBe(CODEX_PLUGIN_ID);
    expect(builtCodex.bundle.manifest.capabilities).toEqual([
      expect.objectContaining({ id: CODEX_CAPABILITY_ID, type: "runtime", family: CODEX_RUNTIME_FAMILY }),
    ]);
    const capability = required(
      builtCodex.bundle.manifest.capabilities.find((candidate) => candidate.id === CODEX_CAPABILITY_ID),
      "Codex Runtime capability",
    );
    expect(capability.configurationSchema).toEqual(CODEX_BINDING_CONFIGURATION_SCHEMA);
    expect(capability.configurationSchema).not.toHaveProperty("properties.model");
    expect(capability.configurationSchema).not.toHaveProperty("properties.modelReasoningEffort");
    const artifact = required(builtCodex.bundle.manifest.artifacts[0], "Codex target artifact");
    const artifactFile = required(builtCodex.bundle.files[artifact.entry], "Codex target artifact file");
    expect(artifact.target).toBe(target);
    expect(artifact.integrity).toBe(`sha256-${createHash("sha256").update(artifactFile.content).digest("base64")}`);
    expect(artifactFile.content).not.toContain('from "../../runtime/codex-adapter"');
  });

  it("forwards only the host-resolved per-Turn model selection", async () => {
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: [],
      async start() {
        return {
          async *prompt(input) {
            prompts.push(input);
            yield* [];
          },
          async close() {},
        };
      },
    };
    const binding: CodexRuntimeAdapterBinding = {
      runtime: { pluginId: CODEX_PLUGIN_ID, capabilityId: CODEX_CAPABILITY_ID },
      runtimeConfig: {},
      model: { model: "binding-default-must-not-leak" },
      modelReasoningEffort: "xhigh",
    };
    const official = createCodexOfficialAdapter(adapter, binding);
    const session = await official.start({
      activationGeneration: 1,
      bindingId: "codex",
      chatId: "chat",
      sessionId: "session",
      runtimeThreadId: null,
      onRuntimeThreadId: async () => undefined,
      cacheMedia: async () => "",
    });
    const workspace = { workspaceRef: "WSDEFALT", workingDirectory: "/tmp", skipGitRepoCheck: true };

    await Array.fromAsync(
      session.prompt({
        prompt: "selected",
        workspace,
        model: { model: "catalog-selected-model" },
        reasoningEffort: "medium",
      }),
    );
    await Array.fromAsync(session.prompt({ prompt: "runtime default", workspace }));

    expect(prompts.map(({ model, reasoningEffort }) => ({ model, reasoningEffort }))).toEqual([
      { model: { model: "catalog-selected-model" }, reasoningEffort: "medium" },
      { model: undefined, reasoningEffort: undefined },
    ]);
  });

  it("rejects generic model selection in capability Runtime configuration", async () => {
    const setup = await installedHost();
    const binding = pluginBinding(fakeCodexExecutable, join(setup.directory, "invalid-selection"));
    binding.runtimeConfig = {
      ...binding.runtimeConfig,
      model: "configuration-must-not-override",
      modelReasoningEffort: "xhigh",
    };
    try {
      await setup.host.install({
        source: setup.bundlePath,
        target,
        installationConfiguration: { executablePath: fakeCodexExecutable },
      });
      await expect(setup.registry.prepare(binding)).rejects.toThrow("Runtime configuration");
    } finally {
      await setup.host.close();
      await setup.store.close();
    }
  });

  it("executes authoritative input reconciliation through the installed provider", async () => {
    const harness = await createInstalledCodexHarness();
    if (!harness.registry) throw new Error("Installed Codex harness did not return its Runtime registry");
    try {
      await expect(
        harness.registry.reconcileInput(harness.binding, "thread-1", {
          messageId: "message-1",
          contentDigest: "sha256:message-1",
        }),
      ).resolves.toEqual({ outcome: "absent", receipts: { identities: [], complete: true } });
    } finally {
      await harness.registry.close();
      await harness.dispose?.();
    }
  });

  it("updates, disables, re-enables, and removes through common Plugin management", async () => {
    const setup = await installedHost();
    try {
      const installed = await setup.host.install({
        source: setup.bundlePath,
        target,
        installationConfiguration: { executablePath: fakeCodexExecutable },
      });
      expect(installed.status).toBe("active");
      expect((await setup.host.update(CODEX_PLUGIN_ID)).status).toBe("active");
      expect((await setup.host.disable(CODEX_PLUGIN_ID)).status).toBe("disabled");
      expect((await setup.host.enable(CODEX_PLUGIN_ID)).status).toBe("active");
      await setup.host.remove(CODEX_PLUGIN_ID, true);
      expect(await setup.host.list()).toEqual([]);
    } finally {
      await setup.host.close();
      await setup.store.close();
    }
  });

  it("activates the Plugin with this machine's parseable alpha version", async () => {
    const setup = await installedHost();
    const executable = await versionOnlyExecutable(setup.directory, "codex-cli 0.111.0-alpha.14");
    try {
      await expect(
        setup.host.install({
          source: setup.bundlePath,
          target,
          installationConfiguration: { executablePath: executable },
        }),
      ).resolves.toMatchObject({ status: "active" });
      expect(setup.host.activePluginIds()).toEqual([CODEX_PLUGIN_ID]);
    } finally {
      await setup.host.close();
      await setup.store.close();
    }
  });

  it("publishes the Runtime capability before Codex exists and validates when a Binding selects it", async () => {
    const setup = await installedHost();
    const deferredExecutable = join(setup.directory, "codex-installed-later");
    const binding = pluginBinding(deferredExecutable, join(setup.directory, "deferred-binding"));
    delete binding.runtimeConfig.executablePathOverride;
    try {
      await expect(
        setup.host.install({
          source: setup.bundlePath,
          target,
          installationConfiguration: { executablePath: deferredExecutable },
        }),
      ).resolves.toMatchObject({ status: "active" });
      expect(setup.host.activePluginIds()).toEqual([CODEX_PLUGIN_ID]);
      expect(setup.registry.hasProvider(binding)).toBe(true);
      expect(setup.registry.familyFor(binding)).toBe(CODEX_RUNTIME_FAMILY);

      expect(() => setup.registry.modesFor(binding)).toThrow(
        `Failed to inspect configured Codex executable ${deferredExecutable}`,
      );

      await writeFile(deferredExecutable, "#!/bin/sh\nprintf 'codex-cli 0.111.0-alpha.14\\n'\n", { mode: 0o700 });
      expect(setup.registry.modesFor(binding)).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    } finally {
      await setup.host.close();
      await setup.store.close();
    }
  });

  it("defers parseable Binding compatibility to app-server startup and fails real protocol errors", async () => {
    const setup = await installedHost();
    const versionOnly = await versionOnlyExecutable(setup.directory, "codex-cli 0.111.0-alpha.14");
    try {
      await setup.host.install({
        source: setup.bundlePath,
        target,
        installationConfiguration: { executablePath: fakeCodexExecutable },
      });
      await expect(setup.registry.listModels(pluginBinding(versionOnly, setup.directory))).rejects.toThrow(
        "Invalid JSON from Codex app-server",
      );
      await expect(
        setup.registry.listModels(pluginBinding(join(setup.directory, "missing"), setup.directory)),
      ).rejects.toThrow("Failed to inspect configured Codex executable");
    } finally {
      await setup.host.close();
      await setup.store.close();
    }
  });

  it("closes independent app-server instances for independent Bindings", async () => {
    const setup = await installedHost();
    const first = pluginBinding(fakeCodexExecutable, join(setup.directory, "first"));
    const second = pluginBinding(fakeCodexExecutable, join(setup.directory, "second"));
    try {
      await setup.host.install({
        source: setup.bundlePath,
        target,
        installationConfiguration: { executablePath: fakeCodexExecutable },
      });
      await setup.registry.prepare(first);
      await setup.registry.prepare(second);
      await setup.host.disable(CODEX_PLUGIN_ID);
      expect(lineCount(join(setup.directory, "first", "close.log"))).toBe(1);
      expect(lineCount(join(setup.directory, "second", "close.log"))).toBe(1);
    } finally {
      await setup.host.close();
      await setup.store.close();
    }
  });
});

async function createInstalledCodexHarness(): Promise<AdapterHarness> {
  const setup = await installedHost();
  const runtimeDirectory = join(setup.directory, "runtime");
  const binding = pluginBinding(fakeCodexExecutable, runtimeDirectory);
  setup.config.agents = { codex: binding };
  await setup.host.install({
    source: setup.bundlePath,
    target,
    installationConfiguration: { executablePath: fakeCodexExecutable },
  });
  const statePath = join(runtimeDirectory, "state");
  const lifecyclePath = join(runtimeDirectory, "lifecycle.log");
  const closePath = join(runtimeDirectory, "close.log");
  const failArchivePath = join(runtimeDirectory, "fail-archive");
  const hangPath = join(runtimeDirectory, "hang");
  return {
    registry: setup.registry,
    binding,
    expectedDiscoveryStatus: "complete",
    activateThread() {
      writeFileSync(statePath, "active");
    },
    closeCount: () => lineCount(closePath),
    failNextArchive() {
      writeFileSync(failArchivePath, "fail");
    },
    lifecycleCalls: () => (existsSync(lifecyclePath) ? readFileSync(lifecyclePath, "utf8").trim().split("\n") : []),
    async startPendingOperation() {
      writeFileSync(hangPath, "hang");
      return await setup.registry.listModels(binding);
    },
    async dispose() {
      await setup.host.close();
      await setup.store.close();
    },
  };
}

async function installedHost() {
  const directory = await mkdtemp(join(tmpdir(), "connect-official-codex-"));
  const configPath = join(directory, "config.json");
  const bundlePath = join(directory, builtCodex.filename);
  await writeFile(bundlePath, `${JSON.stringify(builtCodex.bundle, null, 2)}\n`);
  const config = defaultConfig();
  const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
  const workspaces = new WorkspaceCatalog(store);
  const registry = new RuntimeAdapterRegistry([]);
  const host = new ConnectPluginHost(configPath, registry, () => undefined, { config, stateStore: store, workspaces });
  return { directory, configPath, bundlePath, config, store, workspaces, registry, host };
}

function pluginBinding(executable: string, directory: string): AgentBindingConfig {
  const runtimeDirectory = resolve(directory);
  mkdirSync(runtimeDirectory, { recursive: true });
  const wrapper = join(runtimeDirectory, "codex");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `export CODEX_HOME=${shellQuote(runtimeDirectory)}`,
      `export CODEX_FAKE_STATE_FILE=${shellQuote(join(runtimeDirectory, "state"))}`,
      `export CODEX_FAKE_LIFECYCLE_FILE=${shellQuote(join(runtimeDirectory, "lifecycle.log"))}`,
      `export CODEX_FAKE_CLOSE_FILE=${shellQuote(join(runtimeDirectory, "close.log"))}`,
      `export CODEX_FAKE_HANG_FILE=${shellQuote(join(runtimeDirectory, "hang"))}`,
      `export CODEX_FAKE_FAIL_ARCHIVE_FILE=${shellQuote(join(runtimeDirectory, "fail-archive"))}`,
      `exec ${shellQuote(executable)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return {
    runtime: { pluginId: CODEX_PLUGIN_ID, capabilityId: CODEX_CAPABILITY_ID },
    runtimeConfig: {
      executablePathOverride: wrapper,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      webSearchMode: "live",
      networkAccessEnabled: true,
      additionalDirectories: [runtimeDirectory],
      outputVisibility: "full",
    },
    model: { model: "gpt-5-codex" },
    modelReasoningEffort: "high",
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function versionOnlyExecutable(directory: string, version: string): Promise<string> {
  const executable = join(directory, `codex-${version.replaceAll(/[^0-9A-Za-z]+/gu, "-")}`);
  await writeFile(executable, `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o700 });
  return executable;
}

function lineCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}
