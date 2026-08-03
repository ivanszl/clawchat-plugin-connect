import { type WorkBuddyProfile, workBuddyProfileCompatibility } from "../../src/runtime/workbuddy-task-discovery";

const selectedProfile = process.env.WORKBUDDY_TEST_PROFILE ?? "workbuddy-ai";
if (selectedProfile !== "workbuddy-ai" && selectedProfile !== "workbuddy-cn") {
  throw new Error("WORKBUDDY_TEST_PROFILE must be workbuddy-ai or workbuddy-cn");
}

export const workBuddyTestProfile: WorkBuddyProfile = selectedProfile;
export const workBuddyTestCompatibility = workBuddyProfileCompatibility(workBuddyTestProfile);
export const workBuddyTestEnvPrefix =
  workBuddyTestProfile === "workbuddy-ai" ? "WORKBUDDY_AI_TEST" : "WORKBUDDY_CN_TEST";
export const workBuddyTestBindingId = `installed-${workBuddyTestProfile}`;

export function workBuddyTestEnv(name: string): string | undefined {
  return process.env[`${workBuddyTestEnvPrefix}_${name}`];
}

export function requiredWorkBuddyTestEnv(names: string[], purpose: string): Record<string, string> {
  if (workBuddyTestEnv("DEDICATED_TASK") !== "1") {
    throw new Error(
      `Set ${workBuddyTestEnvPrefix}_DEDICATED_TASK=1 only after confirming that the configured Task is reserved for installed release verification.`,
    );
  }
  const values = Object.fromEntries(names.map((name) => [name, workBuddyTestEnv(name)]));
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.map((name) => `${workBuddyTestEnvPrefix}_${name}`).join(", ")} to ${purpose} for a dedicated ${workBuddyTestCompatibility.displayName} Task.`,
    );
  }
  return values as Record<string, string>;
}
