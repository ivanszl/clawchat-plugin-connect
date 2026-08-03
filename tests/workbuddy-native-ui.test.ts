import { describe, expect, it } from "bun:test";
import { shouldRestoreInstalledWorkBuddyNativeTask } from "./integration/workbuddy-native-ui";

describe("installed WorkBuddy native UI verification", () => {
  it("does not restore the Task that marker verification already selected", () => {
    expect(shouldRestoreInstalledWorkBuddyNativeTask("connect-qa", "connect-qa")).toBe(false);
  });

  it("restores a different Task after marker verification", () => {
    expect(shouldRestoreInstalledWorkBuddyNativeTask("connect-qa", "prior-task")).toBe(true);
  });
});
