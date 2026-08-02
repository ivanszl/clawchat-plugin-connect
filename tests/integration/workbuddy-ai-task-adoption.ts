import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../../src/client-interface/session-catalog";
import { TranscriptProjection } from "../../src/client-interface/transcript-projection";
import { defaultConfig } from "../../src/config";
import { createReleasedRuntimeAdapterRegistry } from "../../src/runtime/released-adapters";
import { createStateStore } from "../../src/state";
import type { WorkBuddyAgentBindingConfig } from "../../src/types";

const taskId = process.env.WORKBUDDY_AI_TEST_TASK_ID;
const workspace = process.env.WORKBUDDY_AI_TEST_TASK_WORKSPACE;
const userMarker = process.env.WORKBUDDY_AI_TEST_USER_MARKER;
const assistantMarker = process.env.WORKBUDDY_AI_TEST_ASSISTANT_MARKER;
if (!taskId || !workspace || !userMarker || !assistantMarker) {
  throw new Error(
    "Set WORKBUDDY_AI_TEST_TASK_ID, WORKBUDDY_AI_TEST_TASK_WORKSPACE, WORKBUDDY_AI_TEST_USER_MARKER, and WORKBUDDY_AI_TEST_ASSISTANT_MARKER to a dedicated UI-seeded WorkBuddy AI Task.",
  );
}

const directory = await mkdtemp(join(tmpdir(), "clawchat-workbuddy-ai-adoption-"));
const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
const runtimeAdapters = createReleasedRuntimeAdapterRegistry();
const binding: WorkBuddyAgentBindingConfig = { kind: "workbuddy", profile: "workbuddy-ai" };
const config = defaultConfig();
config.defaultAgent = "installed-workbuddy-ai";
config.agents = { "installed-workbuddy-ai": binding };
const transcriptProjection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters });
const catalog = new SessionCatalog({ config, stateStore: store, runtimeAdapters, transcriptProjection });

try {
  const canonicalWorkspace = await realpath(workspace);
  const threads = await runtimeAdapters.discoverAllThreads(binding);
  const thread = threads.find((candidate) => candidate.runtimeThreadId === taskId);
  if (!thread) throw new Error("The dedicated WorkBuddy AI Task was not discovered as a Runtime Thread");
  if (thread.workingDirectory !== canonicalWorkspace) {
    throw new Error("The discovered WorkBuddy AI Task workspace did not match the dedicated UI Task");
  }

  const view = await catalog.view(true);
  let sessionRef: string | null = null;
  for (const entry of view.bindings.flatMap((candidate) => candidate.entries)) {
    const target = await store.getSessionRefTarget(entry.sessionRef);
    if (target?.runtimeSessionId === taskId) {
      sessionRef = entry.sessionRef;
      break;
    }
  }
  if (!sessionRef) throw new Error("The dedicated WorkBuddy AI Task was not exposed through Session Catalog");
  const adopted = await catalog.adopt(sessionRef);
  if (adopted?.runtimeSessionId !== taskId) throw new Error("Session adoption did not persist the stable Task ID");
  if (!(await catalog.ensureProjection(sessionRef, true))) throw new Error("The adopted Task could not be projected");

  const blocks = await store.listTranscriptBlocks(sessionRef);
  const userHistoryVisible = blocks.some((block) => block.plainText.includes(userMarker));
  const assistantHistoryVisible = blocks.some((block) => block.plainText.includes(assistantMarker));
  if (!userHistoryVisible || !assistantHistoryVisible) {
    throw new Error("The adopted Connect Transcript did not contain the dedicated UI Task history");
  }
  process.stdout.write(
    `${JSON.stringify({
      profile: binding.profile,
      taskId,
      workspace: canonicalWorkspace,
      titlePresent: Boolean(thread.name),
      updatedAt: thread.updatedAt,
      runtimeActivityCount: blocks.length,
      completeness: transcriptProjection.completeness(sessionRef),
      userHistoryVisible,
      assistantHistoryVisible,
      submittedPrompt: false,
      verified: true,
    })}\n`,
  );
} finally {
  await runtimeAdapters.close();
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
