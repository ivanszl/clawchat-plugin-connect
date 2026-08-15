import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin } from "../../scripts/build-official-plugins";
import { defaultConfig } from "../../src/config";
import { createStateStore } from "../../src/persistence/state";
import { ConnectPluginHost } from "../../src/plugin/host";
import codexDescriptor from "../../src/plugin/official/codex-descriptor";
import { CODEX_CAPABILITY_ID, CODEX_PLUGIN_ID, CODEX_RUNTIME_FAMILY } from "../../src/plugin/official/codex-manifest";
import { ProjectCatalog } from "../../src/projects/projects";
import { RuntimeAdapterRegistry } from "../../src/runtime/registry";
import type { ConnectRuntimePrompt } from "../../src/runtime/types";
import type { PluginAgentBindingConfig } from "../../src/types";

const executable = process.env.CODEX_INTEGRATION_PATH?.trim() || Bun.which("codex");
if (!executable) throw new Error("Codex integration requires CODEX_INTEGRATION_PATH or codex in PATH");
const directory = await mkdtemp(join(tmpdir(), "connect-codex-plugin-integration-"));
const configPath = join(directory, "config.json");
const config = defaultConfig();
config.stateDbPath = join(directory, "state.sqlite");
const store = createStateStore({ dbPath: config.stateDbPath });
const projects = new ProjectCatalog(store);
const runtimeAdapters = new RuntimeAdapterRegistry([]);
const host = new ConnectPluginHost(configPath, runtimeAdapters, () => undefined, {
  config,
  stateStore: store,
  projects,
});
const target = `${process.platform}-${process.arch}`;
const built = await buildOfficialPlugin(codexDescriptor, { target, write: false });
const bundlePath = join(directory, built.filename);
await writeFile(bundlePath, `${JSON.stringify(built.bundle, null, 2)}\n`);
const binding: PluginAgentBindingConfig = {
  kind: "plugin",
  runtimeFamily: CODEX_RUNTIME_FAMILY,
  runtime: { pluginId: CODEX_PLUGIN_ID, capabilityId: CODEX_CAPABILITY_ID },
  runtimeConfig: { executablePathOverride: executable },
};
config.agents = { integration: binding };

try {
  await host.install({
    source: bundlePath,
    target,
    installationConfiguration: { executablePath: executable },
  });
  const models = await runtimeAdapters.listModels(binding);
  if (!models || models.length === 0) throw new Error("Codex app-server advertised no visible models");
  const selected = models.find((model) => model.isDefault) ?? models[0];
  if (!selected) throw new Error("Codex app-server advertised no default model");
  let runtimeThreadId: string | null = null;
  const session = await runtimeAdapters.start(binding, {
    agentId: "integration",
    chatId: "integration-model-catalog",
    sessionId: crypto.randomUUID(),
    runtimeSessionId: null,
    configPath,
    stateDbPath: config.stateDbPath,
    onRuntimeSessionId: async (value) => {
      if (runtimeThreadId && runtimeThreadId !== value) {
        throw new Error("Codex model switch replaced the Runtime Thread");
      }
      runtimeThreadId = value;
    },
  });
  const prompt = async (input: ConnectRuntimePrompt) => {
    const events = [];
    for await (const event of session.prompt(input)) events.push(event);
    const failure = events.find((event) => event.kind === "error" && event.text.startsWith("Codex execution failed:"));
    if (failure) throw new Error(failure.text);
  };
  const inputFor = (model: typeof selected): ConnectRuntimePrompt => ({
    prompt: "Reply with OK only.",
    workspace: {
      projectId: null,
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
    },
    mode: "read-only",
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort,
    outputPolicy: { mode: "client-full", allowedKinds: ["final"] },
  });
  await prompt(inputFor(selected));
  if (!runtimeThreadId) throw new Error("Codex did not return a Runtime Thread ID");
  const originalThreadId = runtimeThreadId;
  const alternate = models.find((model) => model.id !== selected.id);
  if (alternate) {
    await prompt(inputFor(alternate));
    if (runtimeThreadId !== originalThreadId) {
      throw new Error("Codex model switch did not resume the same Runtime Thread");
    }
    process.stdout.write(
      `Verified installed Codex Plugin model catalog and ${selected.id} → ${alternate.id} on one Runtime Thread.\n`,
    );
  } else {
    process.stdout.write(
      `Verified installed Codex Plugin model catalog and ${selected.id}; model switch skipped because only one model is advertised.\n`,
    );
  }
  await session.close();
} finally {
  await host.close();
  await store.close();
}
