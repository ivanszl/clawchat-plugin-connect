import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  discoverWorkBuddyTask,
  type WorkBuddyDiscoveryObservation,
  type WorkBuddyEndpointVerification,
  type WorkBuddyProcessIdentity,
  type WorkBuddyTaskDiscoverySource,
} from "../src/runtime/workbuddy-task-discovery";

const taskId = "00000000-0000-4000-8000-000000000001";
const workspace = "/private/tmp/workbuddy-discovery-task";
const applicationPath = "/Applications/WorkBuddy AI.app";

const nativeReplayFingerprint = replayFingerprint(["native-message"]);

function observation(): WorkBuddyDiscoveryObservation {
  return {
    application: {
      path: applicationPath,
      bundleIdentifier: "com.workbuddy.workbuddy-ai",
      version: "5.2.7",
      embeddedCodeBuddyVersion: "2.106.4",
    },
    applicationProcess: { pid: 100, parentPid: 1, executablePath: `${applicationPath}/Contents/MacOS/Electron` },
    task: { id: taskId, workspace, transcriptIdentityMatches: true, replayFingerprint: nativeReplayFingerprint },
    sidecarRegistration: { pid: 110, version: 1 },
    sidecarIdentity: { pid: 110, version: 1, registrationTokenMatches: true },
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
  mutate: (value: WorkBuddyDiscoveryObservation) => void = () => undefined,
  verification: Partial<WorkBuddyEndpointVerification> = {},
  confirmedOwner?: WorkBuddyProcessIdentity | null,
): WorkBuddyTaskDiscoverySource {
  let lastOwner: WorkBuddyProcessIdentity | null = null;
  return {
    inspect: async () => {
      const value = observation();
      mutate(value);
      lastOwner = value.endpointOwner;
      return value;
    },
    verifyEndpoint: async () => ({
      taskId,
      replayFingerprint: nativeReplayFingerprint,
      replayStarted: true,
      replayCompleted: true,
      connectionOwner: lastOwner,
      ...verification,
    }),
    confirmEndpointOwner: async () => (confirmedOwner === undefined ? lastOwner : confirmedOwner),
  };
}

async function failureCode(discoverySource: WorkBuddyTaskDiscoverySource, expectedWorkspace = workspace) {
  try {
    await discoverWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace }, discoverySource);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "success";
}

describe("WorkBuddy Task discovery contract", () => {
  it("discovers the pinned WorkBuddy AI Task through verified WorkBuddy-owned state", async () => {
    await expect(
      discoverWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, source()),
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

  it("fails closed when an empty Task has no independent native identity record", async () => {
    expect(
      await failureCode(
        source((value) => {
          if (value.task) {
            value.task.transcriptIdentityMatches = false;
            value.task.replayFingerprint = replayFingerprint([]);
          }
        }),
      ),
    ).toBe("workspace-identity-mismatch");
  });

  it.each([
    [
      "application-absent",
      (value: WorkBuddyDiscoveryObservation): void => {
        value.application = null;
      },
    ],
    [
      "application-stopped",
      (value: WorkBuddyDiscoveryObservation): void => {
        value.applicationProcess = null;
      },
    ],
    [
      "wrong-distribution",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.application) value.application.bundleIdentifier = "com.workbuddy.workbuddy";
      },
    ],
    [
      "incompatible-version",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.application) value.application.version = "5.2.8";
      },
    ],
    [
      "incompatible-version",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.application) value.application.embeddedCodeBuddyVersion = "2.106.5";
      },
    ],
  ] as const)("returns %s for an incompatible application state", async (code, mutate) => {
    expect(await failureCode(source(mutate))).toBe(code);
  });

  it.each([
    [
      "wrong-owning-process",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.applicationProcess) value.applicationProcess.executablePath = "/tmp/impersonator";
      },
    ],
    [
      "task-not-found",
      (value: WorkBuddyDiscoveryObservation): void => {
        value.task = null;
      },
    ],
    [
      "endpoint-unavailable",
      (value: WorkBuddyDiscoveryObservation): void => {
        value.sidecarRegistration = null;
      },
    ],
    [
      "endpoint-unavailable",
      (value: WorkBuddyDiscoveryObservation): void => {
        value.endpointSession = null;
      },
    ],
    [
      "wrong-owning-process",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.sidecarRegistration) value.sidecarRegistration.version = 2;
        if (value.sidecarIdentity) value.sidecarIdentity.version = 2;
      },
    ],
  ] as const)("returns %s for an incompatible native identity", async (code, mutate) => {
    expect(await failureCode(source(mutate))).toBe(code);
  });

  it.each([
    [
      "non-loopback-endpoint",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.endpointSession) value.endpointSession.endpoint = "http://192.168.1.2:43129/api/v1/acp";
      },
    ],
    [
      "endpoint-stale",
      (value: WorkBuddyDiscoveryObservation): void => {
        value.endpointOwner = null;
      },
    ],
    [
      "endpoint-stale",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.sidecarIdentity) value.sidecarIdentity.registrationTokenMatches = false;
      },
    ],
    [
      "recycled-endpoint",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.endpointOwner) value.endpointOwner.pid = 121;
      },
    ],
    [
      "wrong-owning-process",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.endpointOwner) value.endpointOwner.executablePath = "/tmp/impersonator";
      },
    ],
    [
      "wrong-owning-process",
      (value: WorkBuddyDiscoveryObservation): void => {
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

  it("rejects native transcript metadata that conflicts with the authoritative Task workspace", async () => {
    expect(
      await failureCode(
        source((value) => {
          if (value.task) value.task.transcriptIdentityMatches = false;
        }),
      ),
    ).toBe("workspace-identity-mismatch");
  });

  it.each([{ replayStarted: false }, { replayCompleted: false }])(
    "requires both pinned replay boundaries before trusting Task identity",
    async (verification) => {
      expect(await failureCode(source(undefined, verification))).toBe("task-replay-incomplete");
    },
  );

  it("rejects an ACP replay whose message identity fingerprint differs from the native transcript", async () => {
    expect(await failureCode(source(undefined, { replayFingerprint: replayFingerprint(["different-message"]) }))).toBe(
      "task-identity-mismatch",
    );
  });

  it("rejects a port recycled after the ACP connection is established", async () => {
    expect(
      await failureCode(
        source(
          undefined,
          {},
          {
            pid: 121,
            parentPid: 110,
            executablePath: `${applicationPath}/Contents/MacOS/Electron`,
          },
        ),
      ),
    ).toBe("recycled-endpoint");
  });

  it("rejects a port recycled before ACP Task content is exchanged", async () => {
    expect(
      await failureCode(
        source(undefined, {
          connectionOwner: {
            pid: 121,
            parentPid: 110,
            executablePath: `${applicationPath}/Contents/MacOS/Electron`,
          },
        }),
      ),
    ).toBe("recycled-endpoint");
  });

  it("redacts ephemeral values from failures and JSON diagnostics", async () => {
    const discoverySource = source();
    discoverySource.verifyEndpoint = async () => {
      throw new Error(
        "connectionId=dynamic-connection sessionToken=dynamic-session bearer=dynamic-bearer password=dynamic-password",
      );
    };
    try {
      await discoverWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, discoverySource);
      throw new Error("expected discovery to fail");
    } catch (error) {
      const diagnostic = JSON.stringify(error);
      expect(diagnostic).not.toContain("dynamic-connection");
      expect(diagnostic).not.toContain("dynamic-session");
      expect(diagnostic).not.toContain("dynamic-bearer");
      expect(diagnostic).not.toContain("dynamic-password");
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
    const first = await discoverWorkBuddyTask(
      { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
      rotatingSource,
    );
    endpoint = "http://127.0.0.1:43130/api/v1/acp";
    pid = 130;
    const second = await discoverWorkBuddyTask(
      { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
      rotatingSource,
    );
    expect(second.task.id).toBe(first.task.id);
    expect(second.endpoint).not.toBe(first.endpoint);
    expect(second.owner.endpointProcessId).not.toBe(first.owner.endpointProcessId);
  });
});

function replayFingerprint(messageIds: string[]): string {
  return createHash("sha256").update(JSON.stringify(messageIds)).digest("hex");
}
