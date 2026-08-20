import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/client-interface/session-catalog";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { RuntimeActivity } from "../src/runtime/types";
import {
  createWorkBuddyRuntimeAdapter,
  type WorkBuddyRuntimeAdapterBinding,
  type WorkBuddyRuntimeSource,
} from "../src/runtime/workbuddy-adapter";
import {
  connectWorkBuddyTask,
  discoverWorkBuddyTask,
  type WorkBuddyDiscoveryObservation,
  type WorkBuddyEndpointVerification,
  type WorkBuddyProcessIdentity,
  type WorkBuddyProfile,
  type WorkBuddyTaskDiscoverySource,
  workBuddyProfileCompatibility,
} from "../src/runtime/workbuddy-task-discovery";
import {
  buildWorkBuddyTaskRuntimeRequest,
  createWorkBuddyMacosDiscoverySource,
  readWorkBuddyTaskRuntimeSelection,
  reconcileWorkBuddyTaskRuntime,
} from "../src/runtime/workbuddy-task-discovery-macos";
import { fixedRuntimeAdapter, pluginBinding } from "./runtime-adapter-fixture";

const profiles: [WorkBuddyProfile][] = [["workbuddy-ai"], ["workbuddy-cn"]];
const taskId = "00000000-0000-4000-8000-000000000001";
const port = "43129";
const fixtureApplicationVersion = "2026.8.16";
const fixtureCodeBuddyVersion = "9.99.1-nightly.4";
function preparationIdentity(profile: WorkBuddyProfile) {
  return {
    applicationProcessId: 100,
    sidecarProcessId: 110,
    sidecarVersion: workBuddyProfileCompatibility(profile).sidecarVersion,
    registrationToken: "registration-token",
  };
}

describe.each(profiles)("WorkBuddy profile parity: %s", (profile) => {
  it("uses profile-specific application identity and rejects the other installed distribution", async () => {
    const compatibility = workBuddyProfileCompatibility(profile);
    const source = discoverySource(profile);

    await expect(
      discoverWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
    ).resolves.toMatchObject({
      profile,
      application: {
        path: compatibility.applicationPath,
        version: fixtureApplicationVersion,
        embeddedCodeBuddyVersion: fixtureCodeBuddyVersion,
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

  it.each([
    ["6.0.0", "3.0.0"],
    ["2028.4-rc.1", "11.0.0-nightly.7"],
  ])(
    "accepts application %s with observed CodeBuddy %s when profile and protocol checks pass",
    async (applicationVersion, embeddedCodeBuddyVersion) => {
      const compatibility = workBuddyProfileCompatibility(profile);
      const source = discoverySource(profile);
      const inspect = source.inspect;
      source.inspect = async (input) => {
        const value = await inspect(input);
        if (value.application) {
          value.application.version = applicationVersion;
          value.application.embeddedCodeBuddyVersion = embeddedCodeBuddyVersion;
        }
        return value;
      };

      await expect(
        discoverWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
      ).resolves.toMatchObject({
        profile,
        application: { version: applicationVersion, embeddedCodeBuddyVersion },
        task: { id: taskId },
      });
    },
  );

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
    const binding: WorkBuddyRuntimeAdapterBinding = { ...pluginBinding(), profile };
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
          verification: {
            taskId,
            replayFingerprint: "verified-history",
            replayStarted: true,
            replayCompleted: true,
            activities: history,
            connectionOwner: null,
          },
          async *prompt(request) {
            prompts.push(request.prompt);
            yield activity("native-assistant", "assistant", "continued answer", "live", "1.1");
          },
          close: async () => undefined,
        };
      },
    };
    const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
    const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
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
      const discovery = await adapter.discoverAllThreads?.(binding);
      expect(discovery?.threads).toEqual([
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
        workspace: { workspaceRef: "WSDEFALT", workingDirectory: workspace, skipGitRepoCheck: false },
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

it.each(profiles)(
  "reuses an existing exact Task endpoint for %s without invoking host preparation",
  async (profile) => {
    const compatibility = workBuddyProfileCompatibility(profile);
    expect(compatibility).toMatchObject({
      endpointSessionPrefix: "__workbuddy_cli_host__-",
      sidecarVersion: 3,
      acpVersion: 1,
    });
    const source = discoverySource(profile);
    const inspect = source.inspect;
    const calls: string[] = [];
    source.prepareEndpoint = async () => {
      calls.push("prepare");
    };
    source.inspect = async (input, endpointSelection) => {
      calls.push(`inspect:${endpointSelection}`);
      const value = await inspect(input, endpointSelection);
      if (value.endpointSession) {
        value.endpointSession.sessionId = endpointSelection === "host" ? "__workbuddy_cli_host__-2-048fa1ff" : taskId;
      }
      return value;
    };
    source.connectEndpoint = async () => {
      calls.push("connect");
      const value = await inspect({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, "task");
      return {
        verification: {
          taskId,
          replayFingerprint: "empty",
          replayStarted: true,
          replayCompleted: true,
          activities: [],
          connectionOwner: value.endpointOwner,
        },
        prompt: async function* () {
          yield* [];
        },
        close: async () => undefined,
      };
    };

    const attachment = await connectWorkBuddyTask(
      { profile, taskId, expectedWorkspace: compatibility.configDirectory },
      source,
    );
    expect(calls).toEqual(["inspect:task", "connect"]);
    await attachment.close();
  },
);

it.each(profiles)("does not prepare %s when host Task verification fails", async (profile) => {
  const compatibility = workBuddyProfileCompatibility(profile);
  const source = discoverySource(profile);
  const inspect = source.inspect;
  let preparations = 0;
  source.inspect = async (input, endpointSelection) => {
    const value = await inspect(input, endpointSelection);
    if (value.endpointSession) value.endpointSession.sessionId = "__workbuddy_cli_host__-2-048fa1ff";
    return value;
  };
  source.verifyEndpoint = async () => ({
    taskId,
    replayFingerprint: "wrong-native-transcript",
    replayStarted: true,
    replayCompleted: true,
    activities: [],
    connectionOwner: (await inspect({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, "host"))
      .endpointOwner,
  });
  source.prepareEndpoint = async () => {
    preparations += 1;
  };
  source.connectEndpoint = async () => {
    throw new Error("must not connect");
  };

  await expect(
    connectWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
  ).rejects.toMatchObject({ code: "task-identity-mismatch" });
  expect(preparations).toBe(0);
});

it.each(profiles)("rejects %s when preparation does not rediscover the exact native Task Session", async (profile) => {
  const compatibility = workBuddyProfileCompatibility(profile);
  const source = discoverySource(profile);
  const inspect = source.inspect;
  let connections = 0;
  source.inspect = async (input, endpointSelection) => {
    const value = await inspect(input, endpointSelection);
    if (value.endpointSession) value.endpointSession.sessionId = "__workbuddy_cli_host__-2-048fa1ff";
    return value;
  };
  source.prepareEndpoint = async () => undefined;
  source.connectEndpoint = async () => {
    connections += 1;
    throw new Error("must not connect");
  };

  await expect(
    connectWorkBuddyTask({ profile, taskId, expectedWorkspace: compatibility.configDirectory }, source),
  ).rejects.toMatchObject({ code: "task-identity-mismatch" });
  expect(connections).toBe(0);
});

it.each(profiles)("passes only %s-owned inputs to per-Task runtime preparation", async (profile) => {
  const compatibility = workBuddyProfileCompatibility(profile);
  const selections: unknown[] = [];
  const prepared: unknown[] = [];
  const source = createWorkBuddyMacosDiscoverySource(profile, {
    readTaskRuntimeSelection: async (input) => {
      selections.push(input);
      return { model: `${profile}-model`, permissionMode: profile === "workbuddy-ai" ? "acceptEdits" : "default" };
    },
    prepareTaskRuntime: async (input) => {
      prepared.push(input);
    },
  });

  await source.prepareEndpoint?.({ profile, taskId, expectedWorkspace: tmpdir() }, preparationIdentity(profile));

  expect(selections).toEqual([{ profile, configDirectory: compatibility.configDirectory, taskId }]);
  expect(prepared).toEqual([
    {
      profile,
      applicationPath: compatibility.applicationPath,
      configDirectory: compatibility.configDirectory,
      dataFolderName: compatibility.dataFolderName,
      resourcesPath: join(compatibility.applicationPath, "Contents", "Resources"),
      taskId,
      workspace: await realpath(tmpdir()),
      selection: {
        model: `${profile}-model`,
        permissionMode: profile === "workbuddy-ai" ? "acceptEdits" : "default",
      },
      commandTimeoutMs: 5_000,
      sidecarIdentity: preparationIdentity(profile),
    },
  ]);
  const otherProfile = profile === "workbuddy-ai" ? "workbuddy-cn" : "workbuddy-ai";
  await expect(
    source.prepareEndpoint?.(
      { profile: otherProfile, taskId, expectedWorkspace: tmpdir() },
      preparationIdentity(otherProfile),
    ),
  ).rejects.toMatchObject({ code: "wrong-distribution" });
});

it.each(profiles)("builds the %s Task runtime request entirely from capability-owned inputs", (profile) => {
  const compatibility = workBuddyProfileCompatibility(profile);
  const resourcesPath = join(compatibility.applicationPath, "Contents", "Resources");
  const model = `${profile}-model`;
  const request = buildWorkBuddyTaskRuntimeRequest(
    {
      profile,
      applicationPath: compatibility.applicationPath,
      configDirectory: compatibility.configDirectory,
      dataFolderName: compatibility.dataFolderName,
      resourcesPath,
      taskId,
      workspace: "/private/tmp/workspace",
      selection: { model, permissionMode: "default" },
      commandTimeoutMs: 5_000,
    },
    join(resourcesPath, "app.asar.unpacked", "cli", "bin", "codebuddy"),
    "6.0.0-preview.2",
    "test-gateway-secret",
  );

  expect(request).toMatchObject({
    sessionId: taskId,
    command: join(compatibility.applicationPath, "Contents", "MacOS", "Electron"),
    cwd: "/private/tmp/workspace",
    port: 0,
    env: {
      CODEBUDDY_CONFIG_DIR: compatibility.configDirectory,
      WORKBUDDY_CONFIG_DIR: compatibility.configDirectory,
      WORKBUDDY_DATA_FOLDER_NAME: compatibility.dataFolderName,
      CODEBUDDY_GATEWAY_PASSWORD: "test-gateway-secret",
      CODEBUDDY_BUILTIN_SKILLS_DIR: join(resourcesPath, "app.asar.unpacked", "resources", "builtin-skills"),
      ACC_PRODUCT_CONFIG_PATH: join(resourcesPath, "app.asar.unpacked", "cli", "product.json"),
      WORKBUDDY_APP_PATH: compatibility.applicationPath,
      WORKBUDDY_APP_VERSION: "6.0.0-preview.2",
      WORKBUDDY_RESOURCES_PATH: resourcesPath,
    },
  });
  expect(
    request.args.slice(request.args.indexOf("--permission-mode"), request.args.indexOf("--permission-mode") + 2),
  ).toEqual(["--permission-mode", "default"]);
  expect(request.args.slice(request.args.indexOf("--model"), request.args.indexOf("--model") + 2)).toEqual([
    "--model",
    model,
  ]);
  expect(request.args).not.toContain("--no-session-persistence");
  expect(request.args.join(" ")).toContain("/private/tmp/workspace/**");
});

it("reads the current Task model from the catalog even when no assistant history exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbuddy-cn-selection-"));
  const database = new Database(join(directory, "workbuddy.db"));
  try {
    database.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, permission_mode TEXT, deleted_at INTEGER)");
    database
      .query("INSERT INTO sessions (id, model, permission_mode, deleted_at) VALUES (?, ?, ?, NULL)")
      .run(taskId, "hy3", "acceptEdits");

    await expect(
      readWorkBuddyTaskRuntimeSelection({ profile: "workbuddy-cn", configDirectory: directory, taskId }),
    ).resolves.toEqual({
      model: "hy3",
      permissionMode: "acceptEdits",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(profiles)("fails closed when the %s Task catalog contains an unknown permission mode", async (profile) => {
  const directory = await mkdtemp(join(tmpdir(), `${profile}-permission-selection-`));
  const database = new Database(join(directory, "workbuddy.db"));
  try {
    database.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, permission_mode TEXT, deleted_at INTEGER)");
    database
      .query("INSERT INTO sessions (id, model, permission_mode, deleted_at) VALUES (?, ?, ?, NULL)")
      .run(taskId, "hy3", "future-unverified-mode");

    await expect(
      readWorkBuddyTaskRuntimeSelection({ profile, configDirectory: directory, taskId }),
    ).rejects.toMatchObject({
      code: "incompatible-version",
      details: {
        selectedProfile: profile,
        detectedPermissionMode: "future-unverified-mode",
      },
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("prefers the current catalog model over stale assistant transcript metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbuddy-cn-current-selection-"));
  const database = new Database(join(directory, "workbuddy.db"));
  try {
    database.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, permission_mode TEXT, deleted_at INTEGER)");
    database
      .query("INSERT INTO sessions (id, model, permission_mode, deleted_at) VALUES (?, ?, ?, NULL)")
      .run(taskId, "hy3", "default");
    const transcriptDirectory = join(directory, "projects", "workspace");
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(
      join(transcriptDirectory, `${taskId}.jsonl`),
      `${JSON.stringify({ type: "assistant", providerData: { model: "stale-model" } })}\n`,
    );

    await expect(
      readWorkBuddyTaskRuntimeSelection({ profile: "workbuddy-cn", configDirectory: directory, taskId }),
    ).resolves.toEqual({
      model: "hy3",
      permissionMode: "default",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails closed instead of replacing an existing WorkBuddy-owned Task runtime", async () => {
  const profile = "workbuddy-cn";
  const compatibility = workBuddyProfileCompatibility(profile);
  const resourcesPath = join(compatibility.applicationPath, "Contents", "Resources");
  const request = buildWorkBuddyTaskRuntimeRequest(
    {
      profile,
      applicationPath: compatibility.applicationPath,
      configDirectory: compatibility.configDirectory,
      dataFolderName: compatibility.dataFolderName,
      resourcesPath,
      taskId,
      workspace: "/private/tmp/workspace",
      selection: { model: "new-catalog-model", permissionMode: "default" },
      commandTimeoutMs: 5_000,
    },
    join(resourcesPath, "app.asar.unpacked", "cli", "bin", "codebuddy"),
    "6.0.0-preview.2",
    "test-gateway-secret",
  );
  const calls: Array<{ method: string; params: unknown }> = [];

  await expect(
    reconcileWorkBuddyTaskRuntime(profile, request, 5_000, async (method, _timeoutMs, params) => {
      calls.push({ method, params });
      if (method === "session.list") return [{ sessionId: taskId }];
      return { ok: true };
    }),
  ).rejects.toMatchObject({ code: "endpoint-stale" });

  expect(calls.map((call) => call.method)).toEqual(["session.list"]);
  expect(request.args.slice(request.args.indexOf("--model"), request.args.indexOf("--model") + 2)).toEqual([
    "--model",
    "new-catalog-model",
  ]);
});

it("rejects a failed Task runtime creation even when the Task ID appears afterward", async () => {
  const request = {
    sessionId: taskId,
    command: "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
    args: [],
    cwd: "/private/tmp/workspace",
    env: {},
    port: 0,
  };
  let inventoryCalls = 0;

  await expect(
    reconcileWorkBuddyTaskRuntime("workbuddy-cn", request, 5_000, async (method) => {
      if (method === "session.list") return inventoryCalls++ === 0 ? [] : [{ sessionId: taskId }];
      if (method === "session.create") throw new Error("create rejected");
      return { ok: true };
    }),
  ).rejects.toThrow("create rejected");
  expect(inventoryCalls).toBe(1);
});

it("fails closed when runtime preparation combines AI identity with mainland resources", () => {
  const ai = workBuddyProfileCompatibility("workbuddy-ai");
  const mainland = workBuddyProfileCompatibility("workbuddy-cn");
  expect(() =>
    buildWorkBuddyTaskRuntimeRequest(
      {
        profile: "workbuddy-ai",
        applicationPath: ai.applicationPath,
        configDirectory: mainland.configDirectory,
        dataFolderName: ai.dataFolderName,
        resourcesPath: join(ai.applicationPath, "Contents", "Resources"),
        taskId,
        workspace: "/private/tmp/workspace",
        selection: { model: "ai-model", permissionMode: "default" },
        commandTimeoutMs: 5_000,
      },
      join(ai.applicationPath, "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
      "6.0.0-preview.2",
      "test-gateway-secret",
    ),
  ).toThrow("Task runtime inputs combine resources from different distributions");
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
      version: fixtureApplicationVersion,
      embeddedCodeBuddyVersion: fixtureCodeBuddyVersion,
    },
    applicationProcess,
    task: {
      id: taskId,
      workspace: compatibility.configDirectory,
      transcriptIdentityMatches: true,
      replayFingerprint: "empty",
    },
    sidecarRegistration: { pid: 110, version: compatibility.sidecarVersion },
    sidecarIdentity: {
      pid: 110,
      version: compatibility.sidecarVersion,
      registrationTokenMatches: true,
      registrationToken: "registration-token",
    },
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
