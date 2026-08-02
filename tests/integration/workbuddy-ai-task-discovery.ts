import { realpath } from "node:fs/promises";
import { discoverWorkBuddyTask } from "../../src/runtime/workbuddy-task-discovery";
import { createWorkBuddyMacosDiscoverySource } from "../../src/runtime/workbuddy-task-discovery-macos";
import { requiredWorkBuddyTestEnv, workBuddyTestProfile } from "./workbuddy-test-profile";

const { TASK_ID: taskId, TASK_WORKSPACE: workspace } = requiredWorkBuddyTestEnv(
  ["TASK_ID", "TASK_WORKSPACE"],
  "discover and verify",
);

const discovered = await discoverWorkBuddyTask(
  { profile: workBuddyTestProfile, taskId, expectedWorkspace: await realpath(workspace) },
  createWorkBuddyMacosDiscoverySource(workBuddyTestProfile),
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
