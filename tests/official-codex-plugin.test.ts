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
import { probeCompatibleCodexExecutable } from "../src/plugin/official/codex-compatibility";
import codexDescriptor from "../src/plugin/official/codex-descriptor";
import { CODEX_CAPABILITY_ID, CODEX_PLUGIN_ID, CODEX_RUNTIME_FAMILY } from "../src/plugin/official/codex-manifest";
import { ProjectCatalog } from "../src/projects/projects";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { PluginAgentBindingConfig } from "../src/types";
import { type AdapterHarness, runtimeAdapterConformance } from "./runtime-adapter-conformance";

const target = `${process.platform}-${process.arch}`;
const fakeCodexExecutable = resolve("tests/fixtures/fake-codex-app-server.ts");
const builtCodex = await buildOfficialPlugin(codexDescriptor, { target, write: false });

runtimeAdapterConformance("installed official Codex Plugin", createInstalledCodexHarness);

describe("official Codex Plugin Bundle", () => {
  it("builds self-contained target and probe artifacts with exact integrity", () => {
    expect(builtCodex.bundle.manifest.pluginId).toBe(CODEX_PLUGIN_ID);
    expect(builtCodex.bundle.manifest.capabilities).toEqual([
      expect.objectContaining({ id: CODEX_CAPABILITY_ID, type: "runtime", family: CODEX_RUNTIME_FAMILY }),
    ]);
    const artifact = builtCodex.bundle.manifest.artifacts[0]!;
    const probe = builtCodex.bundle.manifest.probe!;
    expect(artifact.target).toBe(target);
    expect(artifact.integrity).toBe(
      `sha256-${createHash("sha256").update(builtCodex.bundle.files[artifact.entry]!.content).digest("base64")}`,
    );
    expect(probe.integrity).toBe(
      `sha256-${createHash("sha256").update(builtCodex.bundle.files[probe.entry]!.content).digest("base64")}`,
    );
    expect(builtCodex.bundle.files[artifact.entry]!.content).not.toContain('from "../../runtime/codex-adapter"');
  });

  it("reports exact installed Codex compatibility before selection", async () => {
    await expect(
      probeCompatibleCodexExecutable({
        platform: process.platform,
        arch: process.arch,
        findExecutable: async () => fakeCodexExecutable,
      }),
    ).resolves.toEqual({
      detected: true,
      compatible: true,
      version: "codex-cli 0.145.0",
      path: fakeCodexExecutable,
      detail: `Detected supported codex-cli 0.145.0 at ${fakeCodexExecutable}`,
    });
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

  it("rejects unsupported installation executables before Plugin activation", async () => {
    const setup = await installedHost();
    const unsupported = join(setup.directory, "unsupported-install-codex");
    await writeFile(unsupported, "#!/bin/sh\nprintf 'codex-cli 99.0.0\\n'\n", { mode: 0o700 });
    try {
      await expect(
        setup.host.install({
          source: setup.bundlePath,
          target,
          installationConfiguration: { executablePath: unsupported },
        }),
      ).rejects.toThrow("expected exactly codex-cli 0.145.0");
      expect(setup.host.activePluginIds()).toEqual([]);
    } finally {
      await setup.host.close();
      await setup.store.close();
    }
  });

  it("fails closed for unsupported and missing Binding executables", async () => {
    const setup = await installedHost();
    const unsupported = join(setup.directory, "unsupported-codex");
    await writeFile(unsupported, "#!/bin/sh\nprintf 'codex-cli 99.0.0\\n'\n", { mode: 0o700 });
    try {
      await setup.host.install({
        source: setup.bundlePath,
        target,
        installationConfiguration: { executablePath: fakeCodexExecutable },
      });
      await expect(setup.registry.listModels(pluginBinding(unsupported, setup.directory))).rejects.toThrow(
        "expected exactly codex-cli 0.145.0",
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
  const projects = new ProjectCatalog(store);
  const registry = new RuntimeAdapterRegistry([]);
  const host = new ConnectPluginHost(configPath, registry, () => undefined, { config, stateStore: store, projects });
  return { directory, configPath, bundlePath, config, store, projects, registry, host };
}

function pluginBinding(executable: string, directory: string): PluginAgentBindingConfig {
  const runtimeDirectory = resolve(directory);
  mkdirSync(runtimeDirectory, { recursive: true });
  return {
    kind: "plugin",
    runtimeFamily: CODEX_RUNTIME_FAMILY,
    runtime: { pluginId: CODEX_PLUGIN_ID, capabilityId: CODEX_CAPABILITY_ID },
    runtimeConfig: {
      executablePathOverride: executable,
      env: {
        CODEX_HOME: runtimeDirectory,
        CODEX_FAKE_STATE_FILE: join(runtimeDirectory, "state"),
        CODEX_FAKE_LIFECYCLE_FILE: join(runtimeDirectory, "lifecycle.log"),
        CODEX_FAKE_CLOSE_FILE: join(runtimeDirectory, "close.log"),
        CODEX_FAKE_HANG_FILE: join(runtimeDirectory, "hang"),
        CODEX_FAKE_FAIL_ARCHIVE_FILE: join(runtimeDirectory, "fail-archive"),
      },
      model: "gpt-5-codex",
      sandboxMode: "workspace-write",
      modelReasoningEffort: "high",
      approvalPolicy: "never",
      webSearchMode: "live",
      networkAccessEnabled: true,
      additionalDirectories: [runtimeDirectory],
      outputVisibility: "full",
      sessionOptions: { mode: "workspace-write" },
    },
  };
}

function lineCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}
