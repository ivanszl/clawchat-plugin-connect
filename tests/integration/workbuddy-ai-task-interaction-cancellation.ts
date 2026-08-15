import { realpath } from "node:fs/promises";
import type { RuntimeActivity, RuntimeInteractionRequest, RuntimeInteractionResponse } from "../../src/runtime/types";
import { createInstalledWorkBuddyPluginRuntime } from "./workbuddy-installed-plugin";
import { requiredWorkBuddyTestEnv, workBuddyTestBindingId, workBuddyTestProfile } from "./workbuddy-test-profile";

const {
  TASK_ID: taskId,
  TASK_WORKSPACE: workspace,
  INTERACTION_PROMPT: interactionPrompt,
  CANCELLATION_PROMPT: cancellationPrompt,
} = requiredWorkBuddyTestEnv(
  ["TASK_ID", "TASK_WORKSPACE", "INTERACTION_PROMPT", "CANCELLATION_PROMPT"],
  "verify installed Runtime Interaction routing and native prompt cancellation",
);
const canonicalWorkspace = await realpath(workspace);
const installedPlugin = await createInstalledWorkBuddyPluginRuntime(workBuddyTestProfile);
const { binding, runtimeAdapters } = installedPlugin;
const session = await runtimeAdapters.start(binding, {
  agentId: `${workBuddyTestBindingId}-interaction-cancellation`,
  chatId: "client-installed-interaction-cancellation",
  sessionId: "client-installed-interaction-cancellation",
  runtimeSessionId: taskId,
  configPath: "/private/tmp/clawchat-connect-workbuddy-interaction-cancellation.json",
  stateDbPath: "/private/tmp/clawchat-connect-workbuddy-interaction-cancellation.sqlite",
  onRuntimeSessionId: async () => undefined,
});
const runtimeWorkspace = {
  projectId: null,
  workingDirectory: canonicalWorkspace,
  skipGitRepoCheck: false,
};

let interactionAccepted = 0;
const interactions: RuntimeInteractionRequest[] = [];
let interactionFailure: unknown;
try {
  try {
    await collect(
      session.prompt({
        prompt: interactionPrompt,
        turnId: `WB_CONNECT_INTERACTION_${Date.now()}`,
        turnOrigin: "client",
        metadata: { sessionRef: "WBTEST01" },
        interactionPort: {
          request: async (request): Promise<RuntimeInteractionResponse> => {
            interactions.push(request);
            if (request.kind !== "approval") {
              throw new Error("The installed interaction prompt must produce an approval request");
            }
            return { kind: "approval", optionId: "deny" };
          },
        },
        onAccepted: async () => {
          interactionAccepted += 1;
        },
        workspace: runtimeWorkspace,
      }),
    );
  } catch (error) {
    interactionFailure = error;
  }
  if (interactionAccepted !== 1) {
    throw new Error(`Expected one interaction prompt acceptance, observed ${interactionAccepted}`, {
      cause: interactionFailure,
    });
  }
  if (interactions.length !== 1 || interactions[0]?.kind !== "approval") {
    throw new Error(`Expected one installed WorkBuddy approval, observed ${interactions.length}`, {
      cause: interactionFailure,
    });
  }

  let cancellationAccepted!: () => void;
  const accepted = new Promise<void>((resolve) => {
    cancellationAccepted = resolve;
  });
  const cancellation = collect(
    session.prompt({
      prompt: cancellationPrompt,
      turnId: `WB_CONNECT_CANCELLATION_${Date.now()}`,
      turnOrigin: "client",
      onAccepted: async () => cancellationAccepted(),
      workspace: runtimeWorkspace,
    }),
  );
  await Promise.race([
    accepted,
    Bun.sleep(30_000).then(() => {
      throw new Error("The installed cancellation prompt was not accepted before the deadline");
    }),
  ]);
  if (!(await session.cancel?.())) throw new Error("The installed WorkBuddy prompt did not accept cancellation");
  const cancellationActivities = await cancellation;
  if (!cancellationActivities.some((activity) => activity.state === "cancelled")) {
    throw new Error("The installed WorkBuddy cancellation emitted no cancelled Runtime Activity");
  }

  process.stdout.write(
    `${JSON.stringify({
      profile: workBuddyTestProfile,
      taskId,
      interactionKind: interactions[0].kind,
      deniedSafely: true,
      cancellationSettled: true,
      cancellationActivityCount: cancellationActivities.length,
    })}\n`,
  );
} finally {
  await session.close();
  await installedPlugin.close();
}

async function collect(activities: AsyncIterable<RuntimeActivity>): Promise<RuntimeActivity[]> {
  const result: RuntimeActivity[] = [];
  for await (const activity of activities) result.push(activity);
  return result;
}
