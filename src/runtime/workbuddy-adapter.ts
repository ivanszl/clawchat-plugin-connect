import type { ConnectRuntimeAdapter, RuntimeActivitySnapshot } from "./types";
import { attachWorkBuddyTask, type WorkBuddyProfile } from "./workbuddy-task-discovery";
import { createWorkBuddyAiMacosDiscoverySource, listWorkBuddyAiTasks } from "./workbuddy-task-discovery-macos";

export interface WorkBuddyTaskSummary {
  id: string;
  title: string | null;
  workspace: string;
  updatedAt: number;
}

export interface WorkBuddyRuntimeSource {
  listTasks(profile: WorkBuddyProfile): Promise<WorkBuddyTaskSummary[]>;
  attachTask(input: { profile: WorkBuddyProfile; taskId: string; workspace: string }): Promise<RuntimeActivitySnapshot>;
  close?(): Promise<void>;
}

export interface WorkBuddyRuntimeAdapterOptions {
  createSource?: () => WorkBuddyRuntimeSource;
}

export function createWorkBuddyRuntimeAdapter(options: WorkBuddyRuntimeAdapterOptions = {}): ConnectRuntimeAdapter {
  const source = (options.createSource ?? createDefaultSource)();
  const discoverAllThreads: NonNullable<ConnectRuntimeAdapter["discoverAllThreads"]> = async (binding) => {
    if (binding.kind !== "workbuddy") throw new Error("WorkBuddy Runtime Adapter requires a WorkBuddy Binding");
    return (await source.listTasks(binding.profile)).map((task) => ({
      runtimeThreadId: task.id,
      name: task.title,
      updatedAt: task.updatedAt,
      workingDirectory: task.workspace,
      workspaceKind: "persistent" as const,
      workspaceIdentity: { key: task.workspace, kind: "persistent" as const, localRoot: task.workspace },
    }));
  };
  return {
    kind: "workbuddy",
    modes: [],
    lifecycleCapabilities: { archive: false, restore: false, delete: false },
    discoverAllThreads,
    discoverThreads: async (binding, workspace) =>
      (await discoverAllThreads(binding)).filter((thread) => thread.workingDirectory === workspace.workingDirectory),
    readActivity: async (binding, runtimeThreadId) => {
      if (binding.kind !== "workbuddy") throw new Error("WorkBuddy Runtime Adapter requires a WorkBuddy Binding");
      const task = (await source.listTasks(binding.profile)).find((candidate) => candidate.id === runtimeThreadId);
      if (!task) throw new Error(`WorkBuddy Task was not found: ${runtimeThreadId}`);
      return await source.attachTask({
        profile: binding.profile,
        taskId: task.id,
        workspace: task.workspace,
      });
    },
    start: async () => {
      throw new Error("WorkBuddy Task turn submission is not available until a Task is adopted");
    },
    close: async () => await source.close?.(),
  };
}

function createDefaultSource(): WorkBuddyRuntimeSource {
  const discoverySource = createWorkBuddyAiMacosDiscoverySource();
  return {
    listTasks: async (profile) => await listWorkBuddyAiTasks(profile),
    attachTask: async (input) =>
      await attachWorkBuddyTask(
        { profile: input.profile, taskId: input.taskId, expectedWorkspace: input.workspace },
        discoverySource,
      ),
  };
}
