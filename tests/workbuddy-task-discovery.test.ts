import { describe, expect, it } from "bun:test";
import {
  discoverWorkbuddyTask,
  type WorkbuddyDiscoveryObservation,
  type WorkbuddyTaskDiscoverySource,
} from "../src/runtime/workbuddy-task-discovery";

const taskId = "492c96d4-88bd-41e2-9608-7214989bba18";
const workspace = "/private/tmp/workbuddy-discovery-task";
const applicationPath = "/Applications/WorkBuddy AI.app";

function observation(): WorkbuddyDiscoveryObservation {
  return {
    application: {
      path: applicationPath,
      bundleIdentifier: "com.workbuddy.workbuddy-ai",
      version: "5.2.7",
      embeddedCodeBuddyVersion: "2.106.4",
    },
    applicationProcess: { pid: 100, parentPid: 1, executablePath: `${applicationPath}/Contents/MacOS/Electron` },
    task: { id: taskId, workspace },
    sidecarRegistration: { pid: 110, token: "sidecar-secret", version: 1 },
    sidecarIdentity: { pid: 110, token: "sidecar-secret", version: 1 },
    sidecarProcess: { pid: 110, parentPid: 100, executablePath: `${applicationPath}/Contents/MacOS/Electron` },
    endpointSession: {
      sessionId: "__workbuddy_cli_host__-2-fixture",
      pid: 120,
      endpoint: "http://127.0.0.1:43129/api/v1/acp",
    },
    endpointOwner: { pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` },
  };
}

function source(
  mutate: (value: WorkbuddyDiscoveryObservation) => void = () => undefined,
  verification: Partial<{ taskId: string; workspace: string; replayStarted: boolean; replayCompleted: boolean }> = {},
): WorkbuddyTaskDiscoverySource {
  return {
    inspect: async () => {
      const value = observation();
      mutate(value);
      return value;
    },
    verifyEndpoint: async () => ({
      taskId,
      workspace,
      replayStarted: true,
      replayCompleted: true,
      ...verification,
    }),
  };
}

async function failureCode(discoverySource: WorkbuddyTaskDiscoverySource, expectedWorkspace = workspace) {
  try {
    await discoverWorkbuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace }, discoverySource);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "success";
}

describe("WorkBuddy Task discovery contract", () => {
  it("discovers the pinned WorkBuddy AI Task through verified WorkBuddy-owned state", async () => {
    await expect(
      discoverWorkbuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, source()),
    ).resolves.toEqual({
      profile: "workbuddy-ai",
      application: {
        path: applicationPath,
        version: "5.2.7",
        embeddedCodeBuddyVersion: "2.106.4",
        processId: 100,
      },
      task: { id: taskId, workspace },
      owner: { sidecarProcessId: 110, endpointProcessId: 120 },
      endpoint: "http://127.0.0.1:43129/api/v1/acp",
    });
  });

  it.each([
    [
      "application-absent",
      (value: WorkbuddyDiscoveryObservation): void => {
        value.application = null;
      },
    ],
    [
      "application-stopped",
      (value: WorkbuddyDiscoveryObservation): void => {
        value.applicationProcess = null;
      },
    ],
    [
      "wrong-distribution",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.application) value.application.bundleIdentifier = "com.workbuddy.workbuddy";
      },
    ],
    [
      "incompatible-version",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.application) value.application.version = "5.2.8";
      },
    ],
    [
      "incompatible-version",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.application) value.application.embeddedCodeBuddyVersion = "2.106.5";
      },
    ],
  ] as const)("returns %s for an incompatible application state", async (code, mutate) => {
    expect(await failureCode(source(mutate))).toBe(code);
  });

  it.each([
    [
      "non-loopback-endpoint",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.endpointSession) value.endpointSession.endpoint = "http://192.168.1.2:43129/api/v1/acp";
      },
    ],
    [
      "endpoint-stale",
      (value: WorkbuddyDiscoveryObservation): void => {
        value.endpointOwner = null;
      },
    ],
    [
      "endpoint-stale",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.sidecarIdentity) value.sidecarIdentity.token = "replaced-sidecar-secret";
      },
    ],
    [
      "recycled-endpoint",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.endpointOwner) value.endpointOwner.pid = 121;
      },
    ],
    [
      "wrong-owning-process",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.endpointOwner) value.endpointOwner.executablePath = "/tmp/impersonator";
      },
    ],
    [
      "wrong-owning-process",
      (value: WorkbuddyDiscoveryObservation): void => {
        if (value.sidecarProcess) value.sidecarProcess.parentPid = 999;
      },
    ],
  ] as const)("returns %s for an untrusted endpoint", async (code, mutate) => {
    expect(await failureCode(source(mutate))).toBe(code);
  });

  it("rejects a mismatched Task identifier returned by endpoint replay", async () => {
    expect(await failureCode(source(undefined, { taskId: "another-task" }))).toBe("task-identity-mismatch");
  });

  it("rejects a workspace that differs from WorkBuddy's authoritative Task metadata", async () => {
    expect(await failureCode(source(), "/private/tmp/another-workspace")).toBe("workspace-identity-mismatch");
  });

  it("rejects an endpoint-reported workspace mismatch when that private metadata is available", async () => {
    expect(await failureCode(source(undefined, { workspace: "/private/tmp/another-workspace" }))).toBe(
      "workspace-identity-mismatch",
    );
  });

  it("requires the pinned replay boundary before trusting Task identity", async () => {
    expect(await failureCode(source(undefined, { replayCompleted: false }))).toBe("task-replay-incomplete");
  });

  it("redacts ephemeral values from failures and JSON diagnostics", async () => {
    const discoverySource = source();
    discoverySource.verifyEndpoint = async () => {
      throw new Error(
        "connectionId=dynamic-connection sessionToken=dynamic-session bearer=dynamic-bearer password=dynamic-password sidecar-secret",
      );
    };
    try {
      await discoverWorkbuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, discoverySource);
      throw new Error("expected discovery to fail");
    } catch (error) {
      const diagnostic = JSON.stringify(error);
      expect(diagnostic).not.toContain("dynamic-connection");
      expect(diagnostic).not.toContain("dynamic-session");
      expect(diagnostic).not.toContain("dynamic-bearer");
      expect(diagnostic).not.toContain("dynamic-password");
      expect(diagnostic).not.toContain("sidecar-secret");
      expect(diagnostic).toContain("[REDACTED]");
    }
  });

  it("returns rotated live connection data while preserving the stable Task identifier", async () => {
    let endpoint = "http://127.0.0.1:43129/api/v1/acp";
    let pid = 120;
    const rotatingSource = source((value) => {
      if (!value.endpointSession || !value.endpointOwner) return;
      value.endpointSession.endpoint = endpoint;
      value.endpointSession.pid = pid;
      value.endpointOwner.pid = pid;
    });
    const first = await discoverWorkbuddyTask(
      { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
      rotatingSource,
    );
    endpoint = "http://127.0.0.1:43130/api/v1/acp";
    pid = 130;
    const second = await discoverWorkbuddyTask(
      { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
      rotatingSource,
    );
    expect(second.task.id).toBe(first.task.id);
    expect(second.endpoint).not.toBe(first.endpoint);
    expect(second.owner.endpointProcessId).not.toBe(first.owner.endpointProcessId);
  });
});
