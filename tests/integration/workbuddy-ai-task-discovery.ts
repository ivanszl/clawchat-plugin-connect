import { realpath } from "node:fs/promises";
import { discoverWorkBuddyTask } from "../../src/runtime/workbuddy-task-discovery";
import { createWorkBuddyMacosDiscoverySource } from "../../src/runtime/workbuddy-task-discovery-macos";
import { createInstalledWorkBuddyPluginRuntime } from "./workbuddy-installed-plugin";
import { requiredWorkBuddyTestEnv, workBuddyTestProfile } from "./workbuddy-test-profile";

const { TASK_ID: taskId, TASK_WORKSPACE: workspace } = requiredWorkBuddyTestEnv(
  ["TASK_ID", "TASK_WORKSPACE"],
  "discover and verify",
);

const installedPlugin = await createInstalledWorkBuddyPluginRuntime(workBuddyTestProfile);
try {
  const canonicalWorkspace = await realpath(workspace);
  const { binding, runtimeAdapters } = installedPlugin;
  const providerThreads = await runtimeAdapters.discoverAllThreads(binding);
  const providerThread = providerThreads.threads.find((candidate) => candidate.runtimeThreadId === taskId);
  if (!providerThread || providerThread.workingDirectory !== canonicalWorkspace) {
    throw new Error("The official WorkBuddy Runtime provider did not discover the dedicated Task");
  }
  await runtimeAdapters.verifyThreadReady(binding, taskId);
  const discovered = await discoverWorkBuddyTask(
    { profile: workBuddyTestProfile, taskId, expectedWorkspace: canonicalWorkspace },
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
      providerVerified: true,
      verified: true,
    })}\n`,
  );
} finally {
  await installedPlugin.close();
}
