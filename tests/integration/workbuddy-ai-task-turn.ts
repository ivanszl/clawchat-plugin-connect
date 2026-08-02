import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeActivity } from "../../src/runtime/types";
import { createWorkBuddyRuntimeAdapter } from "../../src/runtime/workbuddy-adapter";
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
const turnMarker = process.env.WORKBUDDY_AI_TEST_TURN_MARKER ?? `WB_CONNECT_TURN_${Date.now()}`;
const transcriptPath = await findTranscript(taskId);
const before = await transcriptRecords(transcriptPath);
const priorModel = lastAssistantModel(before);
if (!priorModel) throw new Error("The dedicated WorkBuddy Task has no prior assistant model to preserve");

const binding: WorkBuddyAgentBindingConfig = { kind: "workbuddy", profile: "workbuddy-ai" };
const adapter = createWorkBuddyRuntimeAdapter();
const session = await adapter.start(binding, {
  agentId: "installed-workbuddy-ai",
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
for (const kind of ["user", "assistant", "reasoning", "progress"] as const) {
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

const after = await transcriptRecords(transcriptPath);
const persisted = after.findLast(
  (record) => record.role === "assistant" && JSON.stringify(record.content).includes(turnMarker),
);
if (!persisted) throw new Error("The native WorkBuddy JSONL did not contain the unique turn marker");
const persistedModel = recordModel(persisted);
if (persistedModel !== priorModel) {
  throw new Error(`WorkBuddy Task model changed without an override: ${priorModel} -> ${persistedModel ?? "missing"}`);
}

await adapter.close?.();
console.log(
  JSON.stringify(
    {
      taskId,
      workspace: canonicalWorkspace,
      turnMarker,
      priorAssistantMarker,
      model: persistedModel,
      activityKinds: [...new Set(activities.map((activity) => activity.kind))],
      activityCount: activities.length,
      replayActivityCount: replay.activities.length,
      nativeRecordDelta: after.length - before.length,
    },
    null,
    2,
  ),
);

async function findTranscript(targetTaskId: string): Promise<string> {
  const projectsDirectory = join(homedir(), ".workbuddy-ai", "projects");
  const entries = await readdir(projectsDirectory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsDirectory, entry.name, `${targetTaskId}.jsonl`));
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) existing.push(candidate);
  }
  if (existing.length !== 1) throw new Error(`Expected one native WorkBuddy transcript, found ${existing.length}`);
  return existing[0] as string;
}

async function transcriptRecords(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastAssistantModel(records: Record<string, unknown>[]): string | null {
  const assistant = records.findLast((record) => record.role === "assistant" && record.status === "completed");
  return assistant ? recordModel(assistant) : null;
}

function recordModel(record: Record<string, unknown>): string | null {
  const providerData = record.providerData as Record<string, unknown> | undefined;
  return typeof providerData?.model === "string" ? providerData.model : null;
}
