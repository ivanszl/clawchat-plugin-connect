import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin, type OfficialPluginDescriptor } from "../scripts/build-official-plugins";
import { defaultConfig, saveConfig } from "../src/config";
import { createPluginAgentBinding } from "../src/plugin/binding";
import { ConnectPluginHost } from "../src/plugin/host";
import {
  inspectInstalledDistribution,
  type OfficialWorkBuddyInspection,
  probeOfficialWorkBuddyRuntimes,
} from "../src/plugin/official/workbuddy-compatibility";
import workBuddyDescriptor from "../src/plugin/official/workbuddy-descriptor";
import { createWorkBuddyOfficialAdapter } from "../src/plugin/official/workbuddy-entry";
import {
  OFFICIAL_WORKBUDDY_DISTRIBUTIONS,
  WORKBUDDY_AI_CAPABILITY_ID,
  WORKBUDDY_CN_CAPABILITY_ID,
  WORKBUDDY_OFFICIAL_PLUGIN_ID,
  WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
} from "../src/plugin/official/workbuddy-manifest";
import { listInstalledPlugins } from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { RuntimeActivity } from "../src/runtime/types";
import type { WorkBuddyRuntimeSource } from "../src/runtime/workbuddy-adapter";
import {
  WORKBUDDY_AI_COMPATIBILITY,
  WORKBUDDY_CN_COMPATIBILITY,
  type WorkBuddyProfile,
} from "../src/runtime/workbuddy-task-discovery";
import type { AdapterHarness } from "./runtime-adapter-conformance";
import { runtimeAdapterConformance } from "./runtime-adapter-conformance";

interface ConformanceInstance {
  profile: WorkBuddyProfile | null;
  active: boolean;
  closed: boolean;
  closeCount: number;
  pending: boolean;
}

interface ConformanceState {
  instances: ConformanceInstance[];
}

for (const profile of ["workbuddy-ai", "workbuddy-cn"] as const) {
  runtimeAdapterConformance(`Official WorkBuddy Plugin ${profile}`, async () => await installedHarness(profile));
}

describe("official WorkBuddy Runtime Plugin", () => {
  it("builds a target-specific self-contained Bundle with two strict profile capabilities and a separate probe", async () => {
    const built = await buildOfficialPlugin(workBuddyDescriptor, { target: "darwin-arm64", write: false });
    expect(built.bundle.manifest).toMatchObject({
      pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID,
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      artifacts: [{ target: "darwin-arm64", entry: "artifacts/darwin-arm64.mjs" }],
      probe: { entry: "probe.mjs" },
      capabilities: [
        {
          id: WORKBUDDY_AI_CAPABILITY_ID,
          type: "runtime",
          family: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
          configurationSchema: { type: "object", additionalProperties: false },
        },
        {
          id: WORKBUDDY_CN_CAPABILITY_ID,
          type: "runtime",
          family: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
    });
    const artifact = built.bundle.files["artifacts/darwin-arm64.mjs"]?.content ?? "";
    const probe = built.bundle.files["probe.mjs"]?.content ?? "";
    expect(artifact.length).toBeGreaterThan(1_000);
    expect(probe.length).toBeGreaterThan(500);
    expect(artifact).not.toMatch(/\bfrom\s+["']\.\.?\//u);
    expect(probe).not.toMatch(/\bfrom\s+["']\.\.?\//u);
    expect(probe).not.toContain("createWorkBuddyOfficialPluginEntry");
  });

  it("reports only exact pinned tuples and distinguishes missing from unsupported distributions", async () => {
    const [ai, mainland] = OFFICIAL_WORKBUDDY_DISTRIBUTIONS;
    expect(
      OFFICIAL_WORKBUDDY_DISTRIBUTIONS.map(
        ({ profile, applicationPath, bundleIdentifier, applicationVersion, embeddedCodeBuddyVersion, acpVersion }) => ({
          profile,
          applicationPath,
          bundleIdentifier,
          applicationVersion,
          embeddedCodeBuddyVersion,
          acpVersion,
        }),
      ),
    ).toEqual(
      [WORKBUDDY_AI_COMPATIBILITY, WORKBUDDY_CN_COMPATIBILITY].map(
        ({ profile, applicationPath, bundleIdentifier, applicationVersion, embeddedCodeBuddyVersion, acpVersion }) => ({
          profile,
          applicationPath,
          bundleIdentifier,
          applicationVersion,
          embeddedCodeBuddyVersion,
          acpVersion,
        }),
      ),
    );
    const exact = await probeOfficialWorkBuddyRuntimes(
      { platform: "darwin", arch: "arm64", findExecutable: async () => null },
      {
        inspect: async (distribution): Promise<OfficialWorkBuddyInspection> =>
          distribution.profile === "workbuddy-ai"
            ? {
                status: "supported",
                distribution: ai,
                bundleIdentifier: ai.bundleIdentifier,
                applicationVersion: ai.applicationVersion,
                embeddedCodeBuddyVersion: ai.embeddedCodeBuddyVersion,
              }
            : { status: "missing", distribution: mainland },
      },
    );
    expect(exact).toMatchObject({
      detected: true,
      compatible: true,
      path: ai.applicationPath,
      version: "WorkBuddy AI 5.2.7 + CodeBuddy 2.106.4 + ACP v1",
    });
    expect(exact.detail).toContain("Detected exact WorkBuddy AI 5.2.7 + CodeBuddy 2.106.4 + ACP v1");
    expect(exact.detail).toContain("WorkBuddy 5.3.8 + CodeBuddy 2.115.0 + ACP v1 is missing");

    const unsupported = await probeOfficialWorkBuddyRuntimes(
      { platform: "darwin", arch: "arm64", findExecutable: async () => null },
      {
        inspect: async (distribution): Promise<OfficialWorkBuddyInspection> => ({
          status: "unsupported",
          distribution,
          bundleIdentifier: distribution.bundleIdentifier,
          applicationVersion: `${distribution.applicationVersion}-other`,
          embeddedCodeBuddyVersion: distribution.embeddedCodeBuddyVersion,
        }),
      },
    );
    expect(unsupported).toMatchObject({ detected: true, compatible: false });
    expect(unsupported.detail).toContain("Unsupported workbuddy-ai tuple");
    expect(unsupported.detail).toContain("Unsupported workbuddy-cn tuple");

    await expect(
      probeOfficialWorkBuddyRuntimes(
        { platform: "linux", arch: "x64", findExecutable: async () => null },
        { inspect: inspectInstalledDistribution },
      ),
    ).resolves.toMatchObject({ detected: false, compatible: false });
  });

  it("keeps profile-owned Adapter state isolated and never confuses direct CodeBuddy Sessions with WorkBuddy Tasks", async () => {
    const sourceProfiles: WorkBuddyProfile[] = [];
    const sourceCloses: WorkBuddyProfile[] = [];
    const directStarts: Array<{ profile: WorkBuddyProfile; sessionId: string | null }> = [];
    const taskStarts: Array<{ profile: WorkBuddyProfile; taskId: string }> = [];

    for (const profile of ["workbuddy-ai", "workbuddy-cn"] as const) {
      const taskId = `task-${profile}`;
      const workspace = `/tmp/${profile}`;
      const source: WorkBuddyRuntimeSource = {
        listTasks: async (selectedProfile) => {
          expect(selectedProfile).toBe(profile);
          return [{ id: taskId, title: `${profile} Task`, workspace, updatedAt: 1 }];
        },
        findTask: async (selectedProfile, selectedTaskId) => {
          expect(selectedProfile).toBe(profile);
          return selectedTaskId === taskId ? { id: taskId, title: `${profile} Task`, workspace, updatedAt: 1 } : null;
        },
        attachTask: async (input) => {
          expect(input.profile).toBe(profile);
          return { activities: [activity(`history-${profile}`, "history")], completeness: "complete", limitations: [] };
        },
        startTask: async (input) => {
          expect(input.profile).toBe(profile);
          taskStarts.push({ profile: input.profile, taskId: input.taskId });
          return {
            verification: {
              taskId: input.taskId,
              replayFingerprint: `replay-${profile}`,
              replayStarted: true,
              replayCompleted: true,
              activities: [activity(`history-${profile}`, "history")],
              connectionOwner: null,
            },
            async *prompt() {
              yield activity(`task-live-${profile}`, "live");
            },
            close: async () => undefined,
          };
        },
        close: async () => {
          sourceCloses.push(profile);
        },
      };
      const adapter = createWorkBuddyOfficialAdapter(profile, {
        createSource: () => {
          sourceProfiles.push(profile);
          return source;
        },
        createCodeBuddySession: async (input) => {
          directStarts.push({ profile: input.profile, sessionId: input.sessionId });
          await input.onSessionId(`native-${profile}`);
          return {
            async *prompt() {
              yield activity(`direct-live-${profile}`, "live");
            },
            close: async () => undefined,
          };
        },
      });

      const directThreadIds: string[] = [];
      const direct = await adapter.start({
        agentId: profile,
        chatId: "direct",
        sessionId: "direct",
        runtimeThreadId: null,
        onRuntimeThreadId: async (runtimeThreadId) => {
          directThreadIds.push(runtimeThreadId);
        },
        cacheMedia: async (media) => {
          if (!media.stagedPath) throw new Error("Test media must already be staged");
          return media.stagedPath;
        },
      });
      expect(directThreadIds).toEqual([`codebuddy-session:native-${profile}`]);
      expect((await adapter.readActivity?.(`codebuddy-session:native-${profile}`))?.completeness).toBe("live-only");
      await direct.close();

      const taskThreadIds: string[] = [];
      const task = await adapter.start({
        agentId: profile,
        chatId: "task",
        sessionId: "task",
        runtimeThreadId: taskId,
        onRuntimeThreadId: async (runtimeThreadId) => {
          taskThreadIds.push(runtimeThreadId);
        },
        cacheMedia: async (media) => {
          if (!media.stagedPath) throw new Error("Test media must already be staged");
          return media.stagedPath;
        },
      });
      expect(taskThreadIds).toEqual([]);
      expect((await adapter.readActivity?.(taskId))?.completeness).toBe("complete");
      await task.close();
      await adapter.close?.();
    }

    expect(sourceProfiles).toEqual(["workbuddy-ai", "workbuddy-cn"]);
    expect(sourceCloses).toEqual(["workbuddy-ai", "workbuddy-cn"]);
    expect(directStarts).toEqual([
      { profile: "workbuddy-ai", sessionId: null },
      { profile: "workbuddy-cn", sessionId: null },
    ]);
    expect(taskStarts).toEqual([
      { profile: "workbuddy-ai", taskId: "task-workbuddy-ai" },
      { profile: "workbuddy-cn", taskId: "task-workbuddy-cn" },
    ]);
  });

  it("installs, updates, disables, and removes the built Bundle through the common Plugin host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "official-workbuddy-lifecycle-"));
    const configPath = join(directory, "config.json");
    await saveConfig(defaultConfig(), configPath);
    const initial = await buildOfficialPlugin(workBuddyDescriptor, { outputDirectory: directory });
    const updateDescriptor: OfficialPluginDescriptor = {
      ...workBuddyDescriptor,
      manifest: { ...workBuddyDescriptor.manifest, version: "0.1.0-beta.8" },
    };
    const update = await buildOfficialPlugin(updateDescriptor, { outputDirectory: directory });
    const registry = new RuntimeAdapterRegistry([]);
    const failures: unknown[] = [];
    const host = new ConnectPluginHost(configPath, registry, (_pluginId, error) => failures.push(error));
    const aiBinding = pluginBinding("workbuddy-ai");
    const mainlandBinding = pluginBinding("workbuddy-cn");
    try {
      await expect(host.install({ source: initial.outputPath })).resolves.toMatchObject({ status: "active" });
      expect(registry.lifecycleCapabilities(aiBinding)).toEqual({ archive: false, restore: false, delete: false });
      expect(registry.lifecycleCapabilities(mainlandBinding)).toEqual({
        archive: false,
        restore: false,
        delete: false,
      });
      expect(() =>
        registry.lifecycleCapabilities(
          createPluginAgentBinding({
            runtimeFamily: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
            pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID,
            capabilityId: WORKBUDDY_AI_CAPABILITY_ID,
            configuration: { profile: "workbuddy-cn" },
          }),
        ),
      ).toThrow("configuration");

      await writeFile(initial.outputPath, `${JSON.stringify(update.bundle, null, 2)}\n`);
      await expect(host.update(WORKBUDDY_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({
        version: "0.1.0-beta.8",
        status: "active",
      });
      await expect(host.disable(WORKBUDDY_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({ status: "disabled" });
      expect(() => registry.lifecycleCapabilities(aiBinding)).toThrow("no Runtime Adapter registered for provider");
      await expect(host.remove(WORKBUDDY_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({
        pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID,
      });
      await expect(listInstalledPlugins(configPath)).resolves.toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await host.close();
      await registry.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function installedHarness(profile: WorkBuddyProfile): Promise<AdapterHarness> {
  const directory = await mkdtemp(join(tmpdir(), `official-workbuddy-${profile}-conformance-`));
  const configPath = join(directory, "config.json");
  await saveConfig(defaultConfig(), configPath);
  const fixtureDescriptor: OfficialPluginDescriptor = {
    ...workBuddyDescriptor,
    manifest: {
      ...workBuddyDescriptor.manifest,
      pluginId: `${WORKBUDDY_OFFICIAL_PLUGIN_ID}.${profile}.conformance`,
    },
    entrypoint: "tests/fixtures/official-workbuddy-entry.ts",
  };
  const built = await buildOfficialPlugin(fixtureDescriptor, { outputDirectory: directory });
  const registry = new RuntimeAdapterRegistry([]);
  const host = new ConnectPluginHost(configPath, registry, () => undefined);
  await host.install({ source: built.outputPath });
  const capabilityId = profile === "workbuddy-ai" ? WORKBUDDY_AI_CAPABILITY_ID : WORKBUDDY_CN_CAPABILITY_ID;
  const binding = createPluginAgentBinding({
    runtimeFamily: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
    pluginId: fixtureDescriptor.manifest.pluginId,
    capabilityId,
  });
  registry.lifecycleCapabilities(binding);
  const globals = globalThis as typeof globalThis & {
    __officialWorkBuddyConformance?: ConformanceState;
  };
  const instance = globals.__officialWorkBuddyConformance?.instances.at(-1);
  if (!instance) throw new Error("Official WorkBuddy conformance Bundle did not create Binding-owned state");

  const closeRegistry = registry.close.bind(registry);
  let cleaned = false;
  registry.close = async () => {
    await closeRegistry();
    await host.close();
    if (!cleaned) {
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    }
  };
  return {
    registry,
    binding,
    activateThread() {
      instance.active = true;
    },
    closeCount: () => instance.closeCount,
    failNextArchive: () => undefined,
    lifecycleCalls: () => [],
    startPendingOperation: async () => {
      instance.active = true;
      instance.pending = true;
      return await registry.readActivity(binding, "thread-1");
    },
  };
}

function pluginBinding(profile: WorkBuddyProfile) {
  return createPluginAgentBinding({
    runtimeFamily: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
    pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID,
    capabilityId: profile === "workbuddy-ai" ? WORKBUDDY_AI_CAPABILITY_ID : WORKBUDDY_CN_CAPABILITY_ID,
  });
}

function activity(id: string, source: "history" | "live"): RuntimeActivity {
  return {
    id,
    position: "0.0",
    parentId: null,
    kind: "assistant",
    text: id,
    state: "complete",
    source,
  };
}
