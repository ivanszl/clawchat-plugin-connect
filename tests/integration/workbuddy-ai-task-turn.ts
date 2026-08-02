import { realpath } from "node:fs/promises";
import type { RuntimeActivity } from "../../src/runtime/types";
import { createWorkBuddyRuntimeAdapter } from "../../src/runtime/workbuddy-adapter";
import { inspectInstalledWorkBuddyTaskTranscript } from "../../src/runtime/workbuddy-task-transcript";
import type { WorkBuddyAgentBindingConfig } from "../../src/types";
import {
  requiredWorkBuddyTestEnv,
  workBuddyTestBindingId,
  workBuddyTestEnv,
  workBuddyTestProfile,
} from "./workbuddy-test-profile";

const {
  TASK_ID: taskId,
  TASK_WORKSPACE: workspace,
  PRIOR_USER_MARKER: priorUserMarker,
  PRIOR_ASSISTANT_MARKER: priorAssistantMarker,
} = requiredWorkBuddyTestEnv(
  ["TASK_ID", "TASK_WORKSPACE", "PRIOR_USER_MARKER", "PRIOR_ASSISTANT_MARKER"],
  "verify context, persistence, and UI synchronization",
);

const canonicalWorkspace = await realpath(workspace);
const turnMarker = workBuddyTestEnv("TURN_MARKER") ?? `WB_CONNECT_TURN_${Date.now()}`;
const before = await inspectInstalledWorkBuddyTaskTranscript(taskId, "", workBuddyTestProfile);
const priorModel = before.latestCompletedAssistantModel;
if (!priorModel) throw new Error("The dedicated WorkBuddy Task has no prior assistant model to preserve");

const binding: WorkBuddyAgentBindingConfig = { kind: "workbuddy", profile: workBuddyTestProfile };
const adapter = createWorkBuddyRuntimeAdapter();
const session = await adapter.start(binding, {
  agentId: workBuddyTestBindingId,
  chatId: "client-installed-verification",
  sessionId: "client-installed-verification",
  runtimeSessionId: taskId,
  configPath: "/private/tmp/clawchat-connect-workbuddy-verification.json",
  stateDbPath: "/private/tmp/clawchat-connect-workbuddy-verification.sqlite",
  onRuntimeSessionId: async () => undefined,
});

const activities: RuntimeActivity[] = [];
let accepted = 0;
try {
  for await (const activity of session.prompt({
    prompt:
      `In the prior WorkBuddy transcript, what exact assistant response followed the user marker ${priorUserMarker}? ` +
      `Reply with that exact prior marker followed by ${turnMarker}, and nothing else.`,
    turnId: turnMarker,
    turnOrigin: "client",
    onAccepted: async () => {
      accepted += 1;
    },
    workspace: {
      projectId: null,
      workingDirectory: canonicalWorkspace,
      additionalDirectories: [],
      skipGitRepoCheck: false,
    },
  })) {
    activities.push(activity);
  }
} finally {
  await session.close();
}

if (accepted !== 1) throw new Error(`Expected one native prompt acceptance, observed ${accepted}`);
if (!activities.some((activity) => activity.state === "streaming")) {
  throw new Error("The installed WorkBuddy turn emitted no streaming Runtime Activity");
}
// Thought chunks are model-dependent: a valid native turn may stream no private reasoning at all.
for (const kind of ["user", "assistant", "progress"] as const) {
  if (!activities.some((activity) => activity.kind === kind)) {
    throw new Error(`The installed WorkBuddy turn emitted no ${kind} Runtime Activity`);
  }
}
const completedAssistant = activities.findLast(
  (activity) => activity.kind === "assistant" && activity.state === "complete",
);
if (!completedAssistant?.text.includes(priorAssistantMarker) || !completedAssistant.text.includes(turnMarker)) {
  throw new Error("The installed WorkBuddy response did not inherit the prior native Task context");
}
if (
  new Set(
    activities
      .filter((activity) => activity.kind === "assistant" && activity.state === "complete")
      .map((activity) => activity.id),
  ).size !== 1
) {
  throw new Error("The installed WorkBuddy turn produced duplicate completed assistant identities");
}

const replay = await adapter.readActivity?.(binding, taskId);
if (!replay?.activities.some((activity) => activity.kind === "user" && activity.text.includes(turnMarker))) {
  throw new Error("The completed Connect turn was not persisted in native WorkBuddy history");
}
if (
  !replay.activities.some(
    (activity) =>
      activity.kind === "assistant" &&
      activity.text.includes(priorAssistantMarker) &&
      activity.text.includes(turnMarker),
  )
) {
  throw new Error("The persisted WorkBuddy history omitted the synchronized assistant result");
}

const after = await inspectInstalledWorkBuddyTaskTranscript(taskId, turnMarker, workBuddyTestProfile);
if (!after.hasCompletedAssistantMarker) {
  throw new Error("The native WorkBuddy transcript did not contain the unique turn marker");
}
const persistedModel = after.latestCompletedAssistantModel;
if (persistedModel !== priorModel) {
  throw new Error(`WorkBuddy Task model changed without an override: ${priorModel} -> ${persistedModel ?? "missing"}`);
}

await adapter.close?.();
console.log(
  JSON.stringify(
    {
      profile: workBuddyTestProfile,
      taskId,
      workspace: canonicalWorkspace,
      turnMarker,
      priorAssistantMarker,
      model: persistedModel,
      activityKinds: [...new Set(activities.map((activity) => activity.kind))],
      activityCount: activities.length,
      replayActivityCount: replay.activities.length,
      nativeRecordDelta: after.recordCount - before.recordCount,
    },
    null,
    2,
  ),
);
