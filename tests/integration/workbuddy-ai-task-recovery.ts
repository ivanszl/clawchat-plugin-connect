import { realpath } from "node:fs/promises";
import type { RuntimeActivity } from "../../src/runtime/types";
import { createWorkBuddyRuntimeAdapter } from "../../src/runtime/workbuddy-adapter";
import { discoverWorkBuddyTask } from "../../src/runtime/workbuddy-task-discovery";
import { createWorkBuddyMacosDiscoverySource } from "../../src/runtime/workbuddy-task-discovery-macos";
import { inspectInstalledWorkBuddyTaskTranscript } from "../../src/runtime/workbuddy-task-transcript";
import type { WorkBuddyAgentBindingConfig } from "../../src/types";
import { selectInstalledWorkBuddyNativeTask } from "./workbuddy-native-ui";
import {
  requiredWorkBuddyTestEnv,
  workBuddyTestBindingId,
  workBuddyTestCompatibility,
  workBuddyTestEnv,
  workBuddyTestProfile,
} from "./workbuddy-test-profile";

const {
  TASK_ID: taskId,
  TASK_WORKSPACE: workspace,
  PRIOR_USER_MARKER: priorUserMarker,
  PRIOR_ASSISTANT_MARKER: priorAssistantMarker,
  UI_TASK_TITLE: uiTaskTitle,
  UI_RESTORE_TASK_TITLE: uiRestoreTaskTitle,
  UI_BACKGROUND_TASK_TITLE: uiBackgroundTaskTitle,
  UI_ORIGINATED_USER_MARKER: uiOriginatedUserMarkerSeed,
  UI_ORIGINATED_ASSISTANT_MARKER: uiOriginatedAssistantMarkerSeed,
} = requiredWorkBuddyTestEnv(
  [
    "TASK_ID",
    "TASK_WORKSPACE",
    "PRIOR_USER_MARKER",
    "PRIOR_ASSISTANT_MARKER",
    "UI_TASK_TITLE",
    "UI_RESTORE_TASK_TITLE",
    "UI_BACKGROUND_TASK_TITLE",
    "UI_ORIGINATED_USER_MARKER",
    "UI_ORIGINATED_ASSISTANT_MARKER",
  ],
  "verify UI-originated turns, background Task switching, application restart, and endpoint rotation",
);

const canonicalWorkspace = await realpath(workspace);
const runMarker = workBuddyTestEnv("RECOVERY_MARKER") ?? `WB_CONNECT_RECOVERY_${Date.now()}`;
const uiOriginatedUserMarker = `${uiOriginatedUserMarkerSeed}_${runMarker}`;
const uiOriginatedAssistantMarker = `${uiOriginatedAssistantMarkerSeed}_${runMarker}`;
const probeMarker = `${runMarker}_NOT_TRANSMITTED`;
const turnMarker = `${runMarker}_CONTINUED`;
const binding: WorkBuddyAgentBindingConfig = { kind: "workbuddy", profile: workBuddyTestProfile };
const discoverySource = createWorkBuddyMacosDiscoverySource(workBuddyTestProfile);
const discoveryInput = { profile: workBuddyTestProfile, taskId, expectedWorkspace: canonicalWorkspace };
const before = await discoverWorkBuddyTask(discoveryInput, discoverySource);
const adapter = createWorkBuddyRuntimeAdapter();
const session = await adapter.start(binding, {
  agentId: `${workBuddyTestBindingId}-recovery`,
  chatId: "client-installed-recovery",
  sessionId: "client-installed-recovery",
  runtimeSessionId: taskId,
  configPath: "/private/tmp/clawchat-connect-workbuddy-recovery.json",
  stateDbPath: "/private/tmp/clawchat-connect-workbuddy-recovery.sqlite",
  onRuntimeSessionId: async () => undefined,
});

try {
  await selectInstalledWorkBuddyNativeTask(workBuddyTestCompatibility, uiTaskTitle);
  process.stdout.write(
    `${JSON.stringify({
      phase: "ready-for-ui-originated-turn",
      taskId,
      instruction: `In the selected dedicated Task, send ${uiOriginatedUserMarker} and require the completed response to contain ${uiOriginatedAssistantMarker}`,
    })}\n`,
  );
  const uiTurnDeadline = Date.now() + 120_000;
  let uiTurnObserved = false;
  while (Date.now() < uiTurnDeadline) {
    await Bun.sleep(500);
    const inspection = await inspectInstalledWorkBuddyTaskTranscript(
      taskId,
      uiOriginatedAssistantMarker,
      workBuddyTestProfile,
    );
    if (inspection.hasCompletedAssistantMarker) {
      uiTurnObserved = true;
      break;
    }
  }
  if (!uiTurnObserved)
    throw new Error("The UI-originated turn did not complete while Connect held the Task Attachment");

  await selectInstalledWorkBuddyNativeTask(workBuddyTestCompatibility, uiBackgroundTaskTitle);
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
    throw new Error(
      `${workBuddyTestCompatibility.displayName} did not restart with rotated process and endpoint data before the recovery deadline`,
    );
  }

  let probeAccepted = 0;
  let probeFailure: unknown;
  const probeActivities: RuntimeActivity[] = [];
  try {
    for await (const activity of session.prompt({
      prompt: `Recovery transport probe ${probeMarker}`,
      turnId: probeMarker,
      turnOrigin: "client",
      onAccepted: async () => {
        probeAccepted += 1;
      },
      workspace: runtimeWorkspace(canonicalWorkspace),
    })) {
      probeActivities.push(activity);
    }
  } catch (error) {
    probeFailure = error;
  }
  if ((probeFailure as { code?: unknown } | null)?.code !== "prompt-not-committed") {
    throw new Error("The pre-acceptance restart probe did not settle as a proven uncommitted prompt", {
      cause: probeFailure,
    });
  }
  if (probeAccepted !== 0) throw new Error(`The restart probe was incorrectly accepted ${probeAccepted} time(s)`);
  const recoveredUiActivities = probeActivities.filter(
    (activity) => activity.text.includes(uiOriginatedUserMarker) || activity.text.includes(uiOriginatedAssistantMarker),
  );
  if (
    !recoveredUiActivities.some((activity) => activity.text.includes(uiOriginatedUserMarker)) ||
    !recoveredUiActivities.some((activity) => activity.text.includes(uiOriginatedAssistantMarker)) ||
    recoveredUiActivities.some((activity) => activity.data?.deliveryDisposition !== "projection-only")
  ) {
    throw new Error("The attached UI-originated turn was not recovered exclusively as projection-only activity");
  }
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
        profile: workBuddyTestProfile,
        runMarker,
        taskId,
        stableTaskIdentity: after.task.id === before.task.id,
        applicationProcessRotated: after.application.processId !== before.application.processId,
        endpointProcessRotated: after.owner.endpointProcessId !== before.owner.endpointProcessId,
        endpointRotated: after.endpoint !== before.endpoint,
        uiOriginatedTurnObserved: uiTurnObserved,
        uiOriginatedProjectionCount: recoveredUiActivities.length,
        backgroundTaskSelected: uiBackgroundTaskTitle,
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
  try {
    await selectInstalledWorkBuddyNativeTask(workBuddyTestCompatibility, uiRestoreTaskTitle);
  } finally {
    await session.close();
    await adapter.close?.();
  }
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
