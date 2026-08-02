import { realpath } from "node:fs/promises";
import { createWorkbuddyAiMacosDiscoverySource, discoverWorkbuddyTask } from "../../src";

const taskId = process.env.WORKBUDDY_AI_TEST_TASK_ID;
const workspace = process.env.WORKBUDDY_AI_TEST_TASK_WORKSPACE;
if (!taskId || !workspace) {
  throw new Error(
    "Set WORKBUDDY_AI_TEST_TASK_ID and WORKBUDDY_AI_TEST_TASK_WORKSPACE to a dedicated WorkBuddy AI test Task.",
  );
}

const discovered = await discoverWorkbuddyTask(
  { profile: "workbuddy-ai", taskId, expectedWorkspace: await realpath(workspace) },
  createWorkbuddyAiMacosDiscoverySource(),
);

process.stdout.write(
  `${JSON.stringify({
    profile: discovered.profile,
    applicationVersion: discovered.application.version,
    embeddedCodeBuddyVersion: discovered.application.embeddedCodeBuddyVersion,
    taskId: discovered.task.id,
    workspace: discovered.task.workspace,
    applicationProcessId: discovered.application.processId,
    sidecarProcessId: discovered.owner.sidecarProcessId,
    endpointProcessId: discovered.owner.endpointProcessId,
    endpoint: discovered.endpoint,
    verified: true,
  })}\n`,
);
