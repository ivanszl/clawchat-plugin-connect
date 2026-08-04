import { realpath } from "node:fs/promises";
import type { RuntimeActivity } from "../../src/runtime/types";
import { createWorkBuddyRuntimeAdapter } from "../../src/runtime/workbuddy-adapter";
import { workBuddyProfileCompatibility } from "../../src/runtime/workbuddy-task-discovery";
import { readWorkBuddyTaskRuntimeSelection } from "../../src/runtime/workbuddy-task-discovery-macos";
import { inspectInstalledWorkBuddyTaskTranscript } from "../../src/runtime/workbuddy-task-transcript";
import type { WorkBuddyAgentBindingConfig } from "../../src/types";
import { verifyInstalledWorkBuddyNativeUi } from "./workbuddy-native-ui";
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
const { UI_TASK_TITLE: uiTaskTitle, UI_RESTORE_TASK_TITLE: uiRestoreTaskTitle } = requiredWorkBuddyTestEnv(
  ["UI_TASK_TITLE", "UI_RESTORE_TASK_TITLE"],
  "verify native UI synchronization and restore the prior application view",
);
const before = await inspectInstalledWorkBuddyTaskTranscript(taskId, "", workBuddyTestProfile);
const selectedModel = (
  await readWorkBuddyTaskRuntimeSelection(workBuddyProfileCompatibility(workBuddyTestProfile).configDirectory, taskId)
).model;
if (!selectedModel) throw new Error("The dedicated WorkBuddy Task has no selected model to preserve");

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
const runtimeWorkspace = {
  projectId: null,
  workingDirectory: canonicalWorkspace,
  skipGitRepoCheck: false,
};
const catalogScope = { runtimeThreadId: taskId, workspace: runtimeWorkspace };
const models = (await adapter.listModels?.(binding, catalogScope)) ?? [];
const currentTaskModel = models.find((model) => model.isDefault);
if (currentTaskModel?.id !== selectedModel) {
  throw new Error(
    `The Task ACP catalog did not report the product-selected model as default: ${selectedModel} -> ${currentTaskModel?.id ?? "missing"}`,
  );
}
if (workBuddyTestProfile === "workbuddy-ai" && !/fast/iu.test(currentTaskModel.displayName)) {
  throw new Error(`The dedicated WorkBuddy AI Task must use a Fast product model, got ${currentTaskModel.displayName}`);
}
const sessionOptions = (await adapter.listSessionOptions?.(binding, runtimeWorkspace, catalogScope)) ?? [];
const commands = (await adapter.listCommands?.(binding, runtimeWorkspace, { runtimeThreadId: taskId })) ?? [];
const skills = (await adapter.listSkills?.(binding, runtimeWorkspace, { runtimeThreadId: taskId })) ?? [];

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
    workspace: runtimeWorkspace,
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
if (persistedModel !== selectedModel) {
  throw new Error(
    `WorkBuddy Task model changed without an override: ${selectedModel} -> ${persistedModel ?? "missing"}`,
  );
}

await adapter.close?.();
await verifyInstalledWorkBuddyNativeUi({
  compatibility: workBuddyProfileCompatibility(workBuddyTestProfile),
  taskTitle: uiTaskTitle,
  marker: turnMarker,
  restoreTaskTitle: uiRestoreTaskTitle,
});
console.log(
  JSON.stringify(
    {
      profile: workBuddyTestProfile,
      taskId,
      workspace: canonicalWorkspace,
      turnMarker,
      priorAssistantMarker,
      model: persistedModel,
      modelDisplayName: currentTaskModel.displayName,
      modeOptions: adapter.modesFor?.(binding, catalogScope) ?? [],
      sessionOptionCount: sessionOptions.length,
      runtimeCommandCount: commands.length,
      runtimeSkillCount: skills.length,
      activityKinds: [...new Set(activities.map((activity) => activity.kind))],
      activityCount: activities.length,
      replayActivityCount: replay.activities.length,
      nativeRecordDelta: after.recordCount - before.recordCount,
      nativeUiVerified: true,
      priorApplicationViewRestored: uiRestoreTaskTitle,
    },
    null,
    2,
  ),
);
