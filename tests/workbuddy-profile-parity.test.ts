import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/client-interface/session-catalog";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { RuntimeActivity } from "../src/runtime/types";
import { createWorkBuddyRuntimeAdapter, type WorkBuddyRuntimeSource } from "../src/runtime/workbuddy-adapter";
import {
  discoverWorkBuddyTask,
  type WorkBuddyDiscoveryObservation,
  type WorkBuddyEndpointVerification,
  type WorkBuddyProcessIdentity,
  type WorkBuddyProfile,
  type WorkBuddyTaskDiscoverySource,
  workBuddyProfileCompatibility,
} from "../src/runtime/workbuddy-task-discovery";
import { createWorkBuddyMacosDiscoverySource } from "../src/runtime/workbuddy-task-discovery-macos";
import { createStateStore } from "../src/state";
import type { WorkBuddyAgentBindingConfig } from "../src/types";

const profiles: [WorkBuddyProfile][] = [["workbuddy-ai"], ["workbuddy-cn"]];
const taskId = "00000000-0000-4000-8000-000000000001";
const port = "43129";

describe.each(profiles)("WorkBuddy profile parity: %s", (profile) => {
  it("uses the profile-specific compatibility tuple and rejects the other installed distribution", async () => {
    const compatibility = workBuddyProfileCompatibility(profile);
    const source = discoverySource(profile);

    await expect(
      discoverWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
    ).resolves.toMatchObject({
      profile,
      application: {
        path: compatibility.applicationPath,
        version: compatibility.applicationVersion,
        embeddedCodeBuddyVersion: compatibility.embeddedCodeBuddyVersion,
      },
      task: { id: taskId, workspace: compatibility.configDirectory },
      endpoint: `http://127.0.0.1:${port}/api/v1/acp`,
    });

    const otherProfile = profile === "workbuddy-ai" ? "workbuddy-cn" : "workbuddy-ai";
    await expect(
      discoverWorkBuddyTask(
        { profile: otherProfile, taskId, expectedWorkspace: compatibility.configDirectory },
        source,
      ),
    ).rejects.toMatchObject({ code: "wrong-distribution", details: { selectedProfile: otherProfile } });
  });

  it("fails with profile-specific compatibility details for any mismatched pinned version", async () => {
    const compatibility = workBuddyProfileCompatibility(profile);
    const source = discoverySource(profile);
    const inspect = source.inspect;
    source.inspect = async (input) => {
      const value = await inspect(input);
      if (value.application) value.application.embeddedCodeBuddyVersion = "unsupported";
      return value;
    };

    await expect(
      discoverWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
    ).rejects.toMatchObject({
      code: "incompatible-version",
      details: {
        selectedProfile: profile,
        supportedApplicationVersion: compatibility.applicationVersion,
        supportedEmbeddedCodeBuddyVersion: compatibility.embeddedCodeBuddyVersion,
        supportedAcpVersion: 1,
      },
    });
  });

  it("does not allow a profile-specific macOS source to inspect the other distribution", async () => {
    const otherProfile = profile === "workbuddy-ai" ? "workbuddy-cn" : "workbuddy-ai";
    await expect(
      createWorkBuddyMacosDiscoverySource(profile).inspect({
        profile: otherProfile,
        taskId,
        expectedWorkspace: workBuddyProfileCompatibility(otherProfile).configDirectory,
      }),
    ).rejects.toMatchObject({
      code: "wrong-distribution",
      details: { selectedProfile: otherProfile, discoverySourceProfile: profile },
    });
  });

  it("discovers, adopts, replays, and continues the same Task through Runtime seams", async () => {
    const directory = await mkdtemp(join(tmpdir(), `${profile}-parity-`));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const binding: WorkBuddyAgentBindingConfig = { kind: "workbuddy", profile };
    const prompts: string[] = [];
    const history = [activity("native-user", "user", "prior context", "history", "0.1")];
    const runtimeSource: WorkBuddyRuntimeSource = {
      listTasks: async (selectedProfile) => {
        expect(selectedProfile).toBe(profile);
        return [{ id: taskId, title: `${profile} task`, workspace, updatedAt: 1_786_000_000_000 }];
      },
      attachTask: async (input) => {
        expect(input).toEqual({ profile, taskId, workspace });
        return { activities: history, completeness: "complete", limitations: [] };
      },
      startTask: async (input) => {
        expect(input).toEqual({ profile, taskId, workspace });
        return {
          async *prompt(request) {
            prompts.push(request.prompt);
            yield activity("native-assistant", "assistant", "continued answer", "live", "1.1");
          },
          close: async () => undefined,
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const registry = new RuntimeAdapterRegistry([{ kind: "workbuddy", create: () => adapter }]);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = profile;
    config.agents = { [profile]: binding };
    const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });
    const catalog = new SessionCatalog({
      config,
      stateStore: store,
      runtimeAdapters: registry,
      transcriptProjection: projection,
    });
    try {
      await expect(adapter.discoverAllThreads?.(binding)).resolves.toEqual([
        expect.objectContaining({
          runtimeThreadId: taskId,
          name: `${profile} task`,
          workingDirectory: workspace,
          updatedAt: 1_786_000_000_000,
        }),
      ]);
      const entry = (await catalog.view()).bindings[0]?.entries[0];
      expect(entry).toMatchObject({ name: `${profile} task`, workspaceName: "workspace" });
      const adopted = await catalog.adopt(entry?.sessionRef ?? "");
      expect(adopted?.runtimeSessionId).toBe(taskId);
      await expect(catalog.ensureProjection(entry?.sessionRef ?? "", true)).resolves.toBe(true);
      expect((await store.listTranscriptBlocks(adopted?.sessionRef ?? "")).map((block) => block.plainText)).toEqual([
        "prior context",
      ]);

      const session = await adapter.start(binding, {
        agentId: profile,
        chatId: "client",
        sessionId: adopted?.sessionId ?? "missing",
        runtimeSessionId: adopted?.runtimeSessionId ?? null,
        configPath: join(directory, "config.json"),
        stateDbPath: join(directory, "state.sqlite"),
        onRuntimeSessionId: async () => undefined,
      });
      const live: RuntimeActivity[] = [];
      for await (const next of session.prompt({
        prompt: "continue from prior context",
        workspace: { projectId: null, workingDirectory: workspace, additionalDirectories: [], skipGitRepoCheck: false },
      })) {
        live.push(next);
      }
      expect(prompts).toEqual(["continue from prior context"]);
      expect(live.map((next) => next.text)).toEqual(["continued answer"]);
      await session.close();
    } finally {
      await registry.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("accepts the mainland sidecar v3 control surface while retaining ACP v1", async () => {
  const profile = "workbuddy-cn";
  const compatibility = workBuddyProfileCompatibility(profile);
  const source = discoverySource(profile);
  const inspect = source.inspect;
  source.inspect = async (input) => {
    const value = await inspect(input);
    if (value.sidecarRegistration) value.sidecarRegistration.version = 3;
    if (value.sidecarIdentity) value.sidecarIdentity.version = 3;
    return value;
  };

  await expect(
    discoverWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
  ).resolves.toMatchObject({ profile });
});

it("materializes a writable mainland Task runtime only for the explicit mainland profile", async () => {
  const prepared: Array<{ taskId: string; workspace: string; applicationPath: string; configDirectory: string }> = [];
  const source = createWorkBuddyMacosDiscoverySource("workbuddy-cn", {
    readTaskModel: async () => "hy3",
    prepareTaskRuntime: async (input) => {
      prepared.push(input);
    },
  });

  await source.prepareEndpoint?.({ profile: "workbuddy-cn", taskId, expectedWorkspace: tmpdir() });

  expect(prepared).toEqual([
    expect.objectContaining({
      taskId,
      workspace: await realpath(tmpdir()),
      applicationPath: "/Applications/WorkBuddy.app",
      configDirectory: workBuddyProfileCompatibility("workbuddy-cn").configDirectory,
      model: "hy3",
    }),
  ]);
  expect(createWorkBuddyMacosDiscoverySource("workbuddy-ai").prepareEndpoint).toBeUndefined();
});

it("accepts the mainland profile host only after exact Task replay verification", async () => {
  const profile = "workbuddy-cn";
  const compatibility = workBuddyProfileCompatibility(profile);
  const source = discoverySource(profile);
  const inspect = source.inspect;
  source.inspect = async (input) => {
    const value = await inspect(input);
    if (value.endpointSession) value.endpointSession.sessionId = "__workbuddy_cli_host__-2-048fa1ff";
    return value;
  };

  await expect(
    discoverWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
  ).resolves.toMatchObject({ profile, task: { id: taskId } });
});

function discoverySource(profile: WorkBuddyProfile): WorkBuddyTaskDiscoverySource {
  const compatibility = workBuddyProfileCompatibility(profile);
  const applicationProcess: WorkBuddyProcessIdentity = {
    pid: 100,
    parentPid: 1,
    executablePath: `${compatibility.applicationPath}/Contents/MacOS/Electron`,
  };
  const sidecarProcess: WorkBuddyProcessIdentity = {
    pid: 110,
    parentPid: 100,
    executablePath: `${compatibility.applicationPath}/Contents/MacOS/Electron`,
  };
  const endpointOwner: WorkBuddyProcessIdentity = {
    pid: 120,
    parentPid: 110,
    executablePath: `${compatibility.applicationPath}/Contents/MacOS/Electron`,
  };
  const observation: WorkBuddyDiscoveryObservation = {
    application: {
      path: compatibility.applicationPath,
      bundleIdentifier: compatibility.bundleIdentifier,
      version: compatibility.applicationVersion,
      embeddedCodeBuddyVersion: compatibility.embeddedCodeBuddyVersion,
    },
    applicationProcess,
    task: {
      id: taskId,
      workspace: compatibility.configDirectory,
      transcriptIdentityMatches: true,
      replayFingerprint: "empty",
    },
    sidecarRegistration: { pid: 110, version: compatibility.sidecarVersion },
    sidecarIdentity: { pid: 110, version: compatibility.sidecarVersion, registrationTokenMatches: true },
    sidecarProcess,
    endpointSession: { sessionId: taskId, pid: 120, endpoint: `http://127.0.0.1:${port}/api/v1/acp` },
    endpointOwner,
  };
  const verification: WorkBuddyEndpointVerification = {
    taskId,
    replayFingerprint: "empty",
    replayStarted: true,
    replayCompleted: true,
    activities: [],
    connectionOwner: endpointOwner,
  };
  return {
    inspect: async () => observation,
    verifyEndpoint: async (input) => {
      expect(input.acpVersion).toBe(1);
      return verification;
    },
    confirmEndpointOwner: async () => endpointOwner,
  };
}

function activity(
  id: string,
  kind: "user" | "assistant",
  text: string,
  source: "history" | "live",
  position: string,
): RuntimeActivity {
  return { id: `workbuddy:${kind}:${id}`, position, parentId: null, kind, text, state: "complete", source };
}
