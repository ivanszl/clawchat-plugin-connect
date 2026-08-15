import { createWorkBuddyOfficialPluginEntry } from "../../src/plugin/official/workbuddy-entry";
import type { RuntimeActivity } from "../../src/runtime/types";
import type { WorkBuddyRuntimeSource } from "../../src/runtime/workbuddy-adapter";
import type { WorkBuddyProfile } from "../../src/runtime/workbuddy-task-discovery";

interface WorkBuddyConformanceInstance {
  profile: WorkBuddyProfile | null;
  active: boolean;
  closed: boolean;
  closeCount: number;
  pending: boolean;
  pendingReject: ((error: Error) => void) | null;
}

interface WorkBuddyConformanceState {
  instances: WorkBuddyConformanceInstance[];
}

const state: WorkBuddyConformanceState = { instances: [] };
const globals = globalThis as typeof globalThis & {
  __officialWorkBuddyConformance?: WorkBuddyConformanceState;
};
globals.__officialWorkBuddyConformance = state;
const activities: RuntimeActivity[] = Array.from({ length: 201 }, (_, index) => ({
  id: `activity-${index}`,
  aliases: [`live-${index}`],
  position: `0.${index + 1}`,
  parentId: null,
  kind: "assistant",
  text: "same output",
  state: "complete",
  source: "history",
}));

function createSource(): WorkBuddyRuntimeSource {
  const instance: WorkBuddyConformanceInstance = {
    profile: null,
    active: false,
    closed: false,
    closeCount: 0,
    pending: false,
    pendingReject: null,
  };
  state.instances.push(instance);
  const selectProfile = (profile: WorkBuddyProfile) => {
    if (instance.closed) throw new Error("binding closed");
    if (instance.profile && instance.profile !== profile) {
      throw new Error(`WorkBuddy conformance Binding crossed profiles: ${instance.profile} -> ${profile}`);
    }
    instance.profile = profile;
  };
  return {
    listTasks: async (profile) => {
      selectProfile(profile);
      return instance.active ? [{ id: "thread-1", title: "Task", workspace: "/tmp", updatedAt: 1 }] : [];
    },
    findTask: async (profile) => {
      selectProfile(profile);
      return { id: "thread-1", title: "Task", workspace: "/tmp", updatedAt: 1 };
    },
    attachTask: async ({ profile }) => {
      selectProfile(profile);
      if (instance.pending) {
        const { promise, reject } = Promise.withResolvers<never>();
        instance.pendingReject = reject;
        return await promise;
      }
      return { activities, completeness: "complete", limitations: [] };
    },
    close: async () => {
      if (instance.closed) return;
      instance.closed = true;
      instance.closeCount += 1;
      instance.pendingReject?.(new Error("binding closed"));
    },
  };
}

export default createWorkBuddyOfficialPluginEntry({ createSource });
