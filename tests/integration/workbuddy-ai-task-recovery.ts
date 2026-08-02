import { realpath } from "node:fs/promises";
import type { RuntimeActivity } from "../../src/runtime/types";
import { createWorkBuddyRuntimeAdapter } from "../../src/runtime/workbuddy-adapter";
import { discoverWorkBuddyTask } from "../../src/runtime/workbuddy-task-discovery";
import { createWorkBuddyAiMacosDiscoverySource } from "../../src/runtime/workbuddy-task-discovery-macos";
import type { WorkBuddyAgentBindingConfig } from "../../src/types";

const taskId = process.env.WORKBUDDY_AI_TEST_TASK_ID;
const workspace = process.env.WORKBUDDY_AI_TEST_TASK_WORKSPACE;
const priorUserMarker = process.env.WORKBUDDY_AI_TEST_PRIOR_USER_MARKER;
const priorAssistantMarker = process.env.WORKBUDDY_AI_TEST_PRIOR_ASSISTANT_MARKER;
if (!taskId || !workspace || !priorUserMarker || !priorAssistantMarker) {
  throw new Error(
    "Set WORKBUDDY_AI_TEST_TASK_ID, WORKBUDDY_AI_TEST_TASK_WORKSPACE, WORKBUDDY_AI_TEST_PRIOR_USER_MARKER, and WORKBUDDY_AI_TEST_PRIOR_ASSISTANT_MARKER to a dedicated WorkBuddy AI test Task.",
  );
}

const canonicalWorkspace = await realpath(workspace);
const runMarker = process.env.WORKBUDDY_AI_TEST_RECOVERY_MARKER ?? `WB_CONNECT_RECOVERY_${Date.now()}`;
const probeMarker = `${runMarker}_NOT_TRANSMITTED`;
const turnMarker = `${runMarker}_CONTINUED`;
const binding: WorkBuddyAgentBindingConfig = { kind: "workbuddy", profile: "workbuddy-ai" };
const discoverySource = createWorkBuddyAiMacosDiscoverySource();
const discoveryInput = { profile: "workbuddy-ai" as const, taskId, expectedWorkspace: canonicalWorkspace };
const before = await discoverWorkBuddyTask(discoveryInput, discoverySource);
const adapter = createWorkBuddyRuntimeAdapter();
const session = await adapter.start(binding, {
  agentId: "installed-workbuddy-ai-recovery",
  chatId: "client-installed-recovery",
  sessionId: "client-installed-recovery",
  runtimeSessionId: taskId,
  configPath: "/private/tmp/clawchat-connect-workbuddy-recovery.json",
  stateDbPath: "/private/tmp/clawchat-connect-workbuddy-recovery.sqlite",
  onRuntimeSessionId: async () => undefined,
});

try {
  process.stdout.write(
    `${JSON.stringify({ phase: "ready-for-restart", runMarker, taskId, applicationProcessId: before.application.processId })}\n`,
  );

  let after = before;
  let rotationDetectedAt: number | null = null;
  const restartDeadline = Date.now() + 120_000;
  while (Date.now() < restartDeadline) {
    await Bun.sleep(500);
    try {
      const candidate = await discoverWorkBuddyTask(discoveryInput, discoverySource);
      if (
        candidate.application.processId !== before.application.processId &&
        candidate.owner.endpointProcessId !== before.owner.endpointProcessId &&
        candidate.endpoint !== before.endpoint
      ) {
        after = candidate;
        rotationDetectedAt ??= Date.now();
        if (Date.now() - rotationDetectedAt >= 5_000) break;
      }
    } catch {
      // WorkBuddy is expected to be temporarily unavailable while the operator restarts it.
    }
  }
  if (after.application.processId === before.application.processId || after.endpoint === before.endpoint) {
    throw new Error("WorkBuddy AI did not restart with rotated process and endpoint data before the recovery deadline");
  }

  let probeAccepted = 0;
  let probeFailure: unknown;
  try {
    await collect(
      session.prompt({
        prompt: `Recovery transport probe ${probeMarker}`,
        turnId: probeMarker,
        turnOrigin: "client",
        onAccepted: async () => {
          probeAccepted += 1;
        },
        workspace: runtimeWorkspace(canonicalWorkspace),
      }),
    );
  } catch (error) {
    probeFailure = error;
  }
  if ((probeFailure as { code?: unknown } | null)?.code !== "prompt-not-committed") {
    throw new Error("The pre-acceptance restart probe did not settle as a proven uncommitted prompt", {
      cause: probeFailure,
    });
  }
  if (probeAccepted !== 0) throw new Error(`The restart probe was incorrectly accepted ${probeAccepted} time(s)`);
  const afterProbe = await adapter.readActivity?.(binding, taskId);
  if (afterProbe?.activities.some((activity) => activity.kind === "user" && activity.text.includes(probeMarker))) {
    throw new Error("The uncommitted restart probe appeared in authoritative WorkBuddy history");
  }

  let accepted = 0;
  const activities = await collect(
    session.prompt({
      prompt:
        `In the prior WorkBuddy transcript, what exact assistant response followed the user marker ${priorUserMarker}? ` +
        `Reply with that exact prior marker followed by ${turnMarker}, and nothing else.`,
      turnId: turnMarker,
      turnOrigin: "client",
      onAccepted: async () => {
        accepted += 1;
      },
      workspace: runtimeWorkspace(canonicalWorkspace),
    }),
  );
  if (accepted !== 1) throw new Error(`Expected one recovered native prompt acceptance, observed ${accepted}`);
  const completedAssistant = activities.findLast(
    (activity) => activity.kind === "assistant" && activity.state === "complete",
  );
  if (!completedAssistant?.text.includes(priorAssistantMarker) || !completedAssistant.text.includes(turnMarker)) {
    throw new Error("The recovered WorkBuddy response did not continue the same native Task context");
  }
  const replay = await adapter.readActivity?.(binding, taskId);
  if (!replay?.activities.some((activity) => activity.kind === "user" && activity.text.includes(turnMarker))) {
    throw new Error("The post-restart Connect prompt was not persisted to the same WorkBuddy Task");
  }
  if (!replay.activities.some((activity) => activity.kind === "assistant" && activity.text.includes(turnMarker))) {
    throw new Error("The post-restart assistant result was not persisted to the same WorkBuddy Task");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        phase: "complete",
        runMarker,
        taskId,
        stableTaskIdentity: after.task.id === before.task.id,
        applicationProcessRotated: after.application.processId !== before.application.processId,
        endpointProcessRotated: after.owner.endpointProcessId !== before.owner.endpointProcessId,
        endpointRotated: after.endpoint !== before.endpoint,
        probeAccepted,
        probeOutcome: "prompt-not-committed",
        continuedAccepted: accepted,
        completedAssistant: completedAssistant.text,
        replayActivityCount: replay.activities.length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await session.close();
  await adapter.close?.();
}

function runtimeWorkspace(workingDirectory: string) {
  return {
    projectId: null,
    workingDirectory,
    additionalDirectories: [],
    skipGitRepoCheck: false,
  };
}

async function collect(activities: AsyncIterable<RuntimeActivity>): Promise<RuntimeActivity[]> {
  const result: RuntimeActivity[] = [];
  for await (const activity of activities) result.push(activity);
  return result;
}
