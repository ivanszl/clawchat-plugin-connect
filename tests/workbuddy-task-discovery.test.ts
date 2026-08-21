import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { workBuddyCapabilityAvailability } from "../src/runtime/workbuddy-availability";
import {
  attachWorkBuddyTask,
  connectWorkBuddyTask,
  discoverWorkBuddyTask,
  WorkBuddyDiscoveryError,
  type WorkBuddyDiscoveryFailureCode,
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
      version: "2026.8.16",
      embeddedCodeBuddyVersion: "9.99.1-nightly.4",
    },
    applicationProcess: { pid: 100, parentPid: 1, executablePath: `${applicationPath}/Contents/MacOS/Electron` },
    task: { id: taskId, workspace, transcriptIdentityMatches: true, replayFingerprint: nativeReplayFingerprint },
    sidecarRegistration: { pid: 110, version: 3 },
    sidecarIdentity: {
      pid: 110,
      version: 3,
      registrationTokenMatches: true,
      registrationToken: "registration-token",
    },
    sidecarProcess: { pid: 110, parentPid: 100, executablePath: `${applicationPath}/Contents/MacOS/Electron` },
    endpointSession: {
      sessionId: taskId,
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
      activities: [],
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

describe("WorkBuddy capability availability", () => {
  it.each([
    ["application-absent"],
    ["wrong-distribution"],
    ["incompatible-version"],
    ["protocol-incompatible"],
  ] satisfies Array<[WorkBuddyDiscoveryFailureCode]>)("classifies %s as unsupported", (code) => {
    expect(workBuddyCapabilityAvailability(code)).toBe("unsupported");
  });

  it.each([
    ["application-stopped"],
    ["discovery-failed"],
    ["endpoint-unavailable"],
    ["endpoint-stale"],
    ["recycled-endpoint"],
    ["authentication-failed"],
  ] satisfies Array<[WorkBuddyDiscoveryFailureCode]>)("classifies %s as unavailable", (code) => {
    expect(workBuddyCapabilityAvailability(code)).toBe("unavailable");
  });

  it.each([
    ["task-not-found"],
    ["workspace-identity-mismatch"],
    ["non-loopback-endpoint"],
    ["wrong-owning-process"],
    ["task-identity-mismatch"],
    ["task-replay-incomplete"],
    ["endpoint-verification-failed"],
  ] satisfies Array<[WorkBuddyDiscoveryFailureCode]>)("classifies %s as conflict", (code) => {
    expect(workBuddyCapabilityAvailability(code)).toBe("conflict");
  });
});

describe("WorkBuddy Task discovery contract", () => {
  it("reports arbitrary observed WorkBuddy AI and CodeBuddy versions after verified WorkBuddy-owned discovery", async () => {
    await expect(
      discoverWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, source()),
    ).resolves.toEqual({
      profile: "workbuddy-ai",
      application: {
        path: applicationPath,
        version: "2026.8.16",
        embeddedCodeBuddyVersion: "9.99.1-nightly.4",
        processId: 100,
      },
      task: { id: taskId, workspace },
      owner: { sidecarProcessId: 110, endpointProcessId: 120 },
      endpoint: "http://127.0.0.1:43129/api/v1/acp",
    });
  });

  it("recognizes the WorkBuddy AI sidecar v3 host as a verified native Task replay surface", async () => {
    await expect(
      discoverWorkBuddyTask(
        { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
        source((value) => {
          if (value.endpointSession) value.endpointSession.sessionId = "__workbuddy_cli_host__-2-048fa1ff";
        }),
      ),
    ).resolves.toMatchObject({ profile: "workbuddy-ai", task: { id: taskId } });
  });

  it("reports an Attachment ready only with the complete verified authoritative replay", async () => {
    await expect(
      attachWorkBuddyTask(
        { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
        source(undefined, {
          activities: [
            {
              id: "native-message",
              position: "0.1",
              parentId: null,
              kind: "user",
              text: "authoritative history",
              state: "complete",
              source: "history",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      activities: [
        {
          id: "native-message",
          position: "0.1",
          parentId: null,
          kind: "user",
          text: "authoritative history",
          state: "complete",
          source: "history",
        },
      ],
      completeness: "complete",
      limitations: [],
    });
  });

  it("closes a retained Attachment when replay or Task verification has not completed", async () => {
    let closes = 0;
    const discoverySource = source();
    discoverySource.connectEndpoint = async () => ({
      verification: {
        taskId,
        replayFingerprint: nativeReplayFingerprint,
        replayStarted: true,
        replayCompleted: false,
        activities: [],
        connectionOwner: observation().endpointOwner,
      },
      prompt: async function* () {
        yield* [];
      },
      close: async () => {
        closes += 1;
      },
    });

    await expect(
      connectWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, discoverySource),
    ).rejects.toMatchObject({ code: "task-replay-incomplete" });
    expect(closes).toBe(1);
  });

  it("reuses a verified exact Task endpoint without replacing the WorkBuddy-owned runtime", async () => {
    const calls: string[] = [];
    const discoverySource = source();
    const inspect = discoverySource.inspect;
    discoverySource.prepareEndpoint = async () => {
      calls.push("prepare");
    };
    discoverySource.inspect = async (input, endpointSelection) => {
      calls.push(`inspect:${endpointSelection}`);
      return await inspect(input, endpointSelection);
    };
    discoverySource.connectEndpoint = async () => {
      calls.push("connect");
      return {
        verification: {
          taskId,
          replayFingerprint: nativeReplayFingerprint,
          replayStarted: true,
          replayCompleted: true,
          activities: [],
          connectionOwner: observation().endpointOwner,
        },
        prompt: async function* () {
          yield* [];
        },
        close: async () => undefined,
      };
    };

    const attachment = await connectWorkBuddyTask(
      { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
      discoverySource,
    );

    expect(calls).toEqual(["inspect:task", "connect"]);
    await attachment.close();
  });

  it.each([
    {
      case: "refused",
      transportError: () =>
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43129"), {
          code: "ECONNREFUSED",
          errno: -61,
          syscall: "connect",
        }),
    },
    {
      case: "reset",
      transportError: () =>
        new Error("The ACP bootstrap failed with redacted transport detail", {
          cause: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
            errno: -54,
            syscall: "read",
          }),
        }),
    },
  ])(
    "reports a $case exact Task ACP socket as stale without replacement or capability fallback",
    async ({ transportError }) => {
      const calls: string[] = [];
      let preparations = 0;
      let snapshotVerifications = 0;
      const discoverySource = source();
      const inspect = discoverySource.inspect;
      discoverySource.inspect = async (input, endpointSelection) => {
        calls.push(`inspect:${endpointSelection}`);
        return await inspect(input, endpointSelection);
      };
      discoverySource.prepareEndpoint = async () => {
        preparations += 1;
        calls.push("prepare");
      };
      discoverySource.verifyEndpoint = async () => {
        snapshotVerifications += 1;
        throw new Error("must not fall back to another verification capability");
      };
      discoverySource.connectEndpoint = async (input) => {
        calls.push(`connect:${input.endpoint}`);
        throw transportError();
      };

      await expect(
        connectWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, discoverySource),
      ).rejects.toMatchObject({ code: "endpoint-stale" });

      expect(calls).toEqual(["inspect:task", "connect:http://127.0.0.1:43129/api/v1/acp"]);
      expect(preparations).toBe(0);
      expect(snapshotVerifications).toBe(0);
    },
  );

  it("keeps an unrelated exact Task ACP failure in endpoint verification without fallback", async () => {
    const calls: string[] = [];
    let preparations = 0;
    let snapshotVerifications = 0;
    const discoverySource = source();
    const inspect = discoverySource.inspect;
    discoverySource.inspect = async (input, endpointSelection) => {
      calls.push(`inspect:${endpointSelection}`);
      return await inspect(input, endpointSelection);
    };
    discoverySource.prepareEndpoint = async () => {
      preparations += 1;
      calls.push("prepare");
    };
    discoverySource.verifyEndpoint = async () => {
      snapshotVerifications += 1;
      throw new Error("must not fall back to another verification capability");
    };
    discoverySource.connectEndpoint = async () => {
      calls.push("connect");
      throw new Error("ACP connect response omitted its connection identifier");
    };

    await expect(
      connectWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, discoverySource),
    ).rejects.toMatchObject({ code: "endpoint-verification-failed" });

    expect(calls).toEqual(["inspect:task", "connect"]);
    expect(preparations).toBe(0);
    expect(snapshotVerifications).toBe(0);
  });

  it("verifies the host before preparation when no exact Task endpoint exists, then requires rediscovery", async () => {
    const calls: string[] = [];
    const preparations: unknown[] = [];
    let prepared = false;
    const discoverySource = source();
    const inspect = discoverySource.inspect;
    discoverySource.prepareEndpoint = async (_input, sidecarIdentity) => {
      calls.push("prepare");
      preparations.push(sidecarIdentity);
      prepared = true;
    };
    discoverySource.inspect = async (input, endpointSelection) => {
      calls.push(`inspect:${endpointSelection}`);
      if (endpointSelection === "task" && !prepared) {
        throw new WorkBuddyDiscoveryError("endpoint-unavailable", "WorkBuddy AI sidecar has no exact Task endpoint.", {
          expectedEndpointKind: "task",
          candidateCount: 0,
        });
      }
      const value = await inspect(input, endpointSelection);
      if (value.endpointSession) {
        value.endpointSession.sessionId = endpointSelection === "host" ? "__workbuddy_cli_host__-2-048fa1ff" : taskId;
      }
      return value;
    };
    discoverySource.connectEndpoint = async () => ({
      verification: {
        taskId,
        replayFingerprint: nativeReplayFingerprint,
        replayStarted: true,
        replayCompleted: true,
        activities: [],
        connectionOwner: observation().endpointOwner,
      },
      prompt: async function* () {
        yield* [];
      },
      close: async () => undefined,
    });

    const attachment = await connectWorkBuddyTask(
      { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
      discoverySource,
    );

    expect(calls).toEqual(["inspect:task", "inspect:host", "prepare", "inspect:task"]);
    expect(preparations).toEqual([
      {
        applicationProcessId: 100,
        sidecarProcessId: 110,
        sidecarVersion: 3,
        registrationToken: "registration-token",
      },
    ]);
    await attachment.close();
  });

  it("normalizes and redacts Task runtime preparation failures", async () => {
    const discoverySource = source();
    const inspect = discoverySource.inspect;
    discoverySource.inspect = async (input, endpointSelection) => {
      if (endpointSelection === "task") {
        throw new WorkBuddyDiscoveryError("endpoint-unavailable", "WorkBuddy AI sidecar has no exact Task endpoint.", {
          expectedEndpointKind: "task",
          candidateCount: 0,
        });
      }
      const value = await inspect(input, endpointSelection);
      if (value.endpointSession) value.endpointSession.sessionId = "__workbuddy_cli_host__-2-048fa1ff";
      return value;
    };
    discoverySource.prepareEndpoint = async () => {
      throw new Error(
        '{"CODEBUDDY_GATEWAY_PASSWORD":"dynamic-gateway"} sessionToken=dynamic-session password=dynamic-password',
      );
    };
    discoverySource.connectEndpoint = async () => {
      throw new Error("must not connect");
    };

    try {
      await connectWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, discoverySource);
      throw new Error("expected preparation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkBuddyDiscoveryError);
      const diagnostic = JSON.stringify((error as WorkBuddyDiscoveryError).toJSON());
      expect(diagnostic).toContain("Task runtime preparation failed");
      expect(diagnostic).not.toContain("dynamic-session");
      expect(diagnostic).not.toContain("dynamic-password");
      expect(diagnostic).not.toContain("dynamic-gateway");
      expect(diagnostic).toContain("[REDACTED]");
    }
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

  it("reports deterministic product-state inspection failures as discovery-failed", async () => {
    const discoverySource = source();
    discoverySource.inspect = async () => {
      throw new Error("native state database could not be read");
    };

    await expect(
      discoverWorkBuddyTask({ profile: "workbuddy-ai", taskId, expectedWorkspace: workspace }, discoverySource),
    ).rejects.toMatchObject({
      code: "discovery-failed",
      message: "WorkBuddy AI Task discovery failed before an endpoint was selected.",
    });
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
      "discovery-failed",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.application) value.application.version = "";
      },
    ],
    [
      "discovery-failed",
      (value: WorkBuddyDiscoveryObservation): void => {
        if (value.application) value.application.embeddedCodeBuddyVersion = " ";
      },
    ],
  ] as const)("returns %s for an incompatible application state", async (code, mutate) => {
    expect(await failureCode(source(mutate))).toBe(code);
  });

  it.each([
    ["6.0.0", "3.0.0"],
    ["2027.1-beta.5", "10.2.0-canary.3"],
  ])(
    "accepts application %s with observed CodeBuddy %s when identity and endpoint checks pass",
    async (version, codeBuddy) => {
      await expect(
        discoverWorkBuddyTask(
          { profile: "workbuddy-ai", taskId, expectedWorkspace: workspace },
          source((value) => {
            if (!value.application) return;
            value.application.version = version;
            value.application.embeddedCodeBuddyVersion = codeBuddy;
          }),
        ),
      ).resolves.toMatchObject({
        application: { version, embeddedCodeBuddyVersion: codeBuddy },
        task: { id: taskId },
      });
    },
  );

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
      "incompatible-version",
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

  it("bounds diagnostics and omits credentials, authorization, product configuration, and native transcript content", () => {
    const error = new WorkBuddyDiscoveryError(
      "endpoint-verification-failed",
      `authorization: Bearer secret-token ${"x".repeat(2_000)}`,
      {
        connectionId: "ephemeral-connection-id",
        session_token: "ephemeral-session-token",
        password: "product-password",
        headers: { authorization: "Bearer other-secret" },
        injectedProductConfiguration: { CODEBUDDY_CONFIG_DIR: "/private/config" },
        transcript: "private native transcript content",
        safe: "operator-safe detail",
      },
    );

    const diagnostic = JSON.stringify(error);
    expect(diagnostic.length).toBeLessThan(2_000);
    expect(diagnostic).not.toMatch(
      /secret-token|other-secret|product-password|ephemeral-connection-id|ephemeral-session-token|CODEBUDDY_CONFIG_DIR|native transcript/u,
    );
    expect(diagnostic).toContain("operator-safe detail");
    expect(diagnostic).toContain("[REDACTED]");
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
