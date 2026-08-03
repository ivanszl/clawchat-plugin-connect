import { realpath } from "node:fs/promises";
import type { WorkBuddyProfile } from "../../src/runtime/workbuddy-task-discovery";
import { listWorkBuddyTasks } from "../../src/runtime/workbuddy-task-discovery-macos";

const profiles = ["workbuddy-ai", "workbuddy-cn"] as const;

const inspections = await Promise.all(profiles.map((profile) => verifyProfile(profile)));
const [aiInspection, cnInspection] = inspections;
if (aiInspection.taskId === cnInspection.taskId) {
  throw new Error("The two dedicated installed-distribution Tasks must have distinct identifiers");
}
if (
  aiInspection.catalogTaskIds.includes(cnInspection.taskId) ||
  cnInspection.catalogTaskIds.includes(aiInspection.taskId)
) {
  throw new Error("A selected WorkBuddy profile exposed the other installed distribution's dedicated Task");
}
const results = inspections.map(({ catalogTaskIds: _catalogTaskIds, ...result }) => result);
process.stdout.write(`${JSON.stringify({ simultaneousInstallationVerified: true, profiles: results }, null, 2)}\n`);

async function verifyProfile(profile: WorkBuddyProfile) {
  const prefix = profile === "workbuddy-ai" ? "WORKBUDDY_AI_TEST" : "WORKBUDDY_CN_TEST";
  if (process.env[`${prefix}_DEDICATED_TASK`] !== "1") {
    throw new Error(`${prefix}_DEDICATED_TASK must be 1 after confirming the selected Task is dedicated to release QA`);
  }
  const taskId = requiredEnv(`${prefix}_TASK_ID`);
  const workspace = await realpath(requiredEnv(`${prefix}_TASK_WORKSPACE`));
  const tasks = await listWorkBuddyTasks(profile);
  const selected = tasks.find((task) => task.id === taskId);
  if (!selected || (await realpath(selected.workspace)) !== workspace) {
    throw new Error(`${profile} did not expose its configured dedicated Task from the selected distribution`);
  }
  return { profile, taskId, workspace, taskCount: tasks.length, catalogTaskIds: tasks.map((task) => task.id) };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for simultaneous installed-distribution verification`);
  return value;
}
