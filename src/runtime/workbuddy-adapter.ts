import type { AgentBindingConfig } from "../types";
import type { ConnectRuntimeAdapter, ConnectRuntimeSession, RuntimeActivitySnapshot } from "./types";
import { attachWorkBuddyTask, connectWorkBuddyTask, type WorkBuddyProfile } from "./workbuddy-task-discovery";
import { createWorkBuddyAiMacosDiscoverySource, listWorkBuddyAiTasks } from "./workbuddy-task-discovery-macos";

export interface WorkBuddyTaskSummary {
  id: string;
  title: string | null;
  workspace: string;
  updatedAt: number;
}

export interface WorkBuddyRuntimeSource {
  listTasks(profile: WorkBuddyProfile): Promise<WorkBuddyTaskSummary[]>;
  findTask?(profile: WorkBuddyProfile, taskId: string): Promise<WorkBuddyTaskSummary | null>;
  attachTask(input: { profile: WorkBuddyProfile; taskId: string; workspace: string }): Promise<RuntimeActivitySnapshot>;
  startTask?(input: { profile: WorkBuddyProfile; taskId: string; workspace: string }): Promise<ConnectRuntimeSession>;
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
  const attachTask = async (binding: AgentBindingConfig, runtimeThreadId: string) => {
    if (binding.kind !== "workbuddy") throw new Error("WorkBuddy Runtime Adapter requires a WorkBuddy Binding");
    const task = source.findTask
      ? await source.findTask(binding.profile, runtimeThreadId)
      : (await source.listTasks(binding.profile)).find((candidate) => candidate.id === runtimeThreadId);
    if (!task) throw new Error(`WorkBuddy Task was not found: ${runtimeThreadId}`);
    return await source.attachTask({
      profile: binding.profile,
      taskId: task.id,
      workspace: task.workspace,
    });
  };
  return {
    kind: "workbuddy",
    modes: [],
    lifecycleCapabilities: { archive: false, restore: false, delete: false },
    discoverAllThreads,
    discoverThreads: async (binding, workspace) =>
      (await discoverAllThreads(binding)).filter((thread) => thread.workingDirectory === workspace.workingDirectory),
    verifyThreadReady: async (binding, runtimeThreadId) => void (await attachTask(binding, runtimeThreadId)),
    readActivity: attachTask,
    start: async (binding, context) => {
      if (binding.kind !== "workbuddy") throw new Error("WorkBuddy Runtime Adapter requires a WorkBuddy Binding");
      if (!context.runtimeSessionId) {
        throw new Error(
          "This conversation is not mapped to a WorkBuddy Task; adopt an existing WorkBuddy Task before submitting a turn.",
        );
      }
      if (!source.startTask)
        throw new Error("WorkBuddy Task turn submission is unavailable for this Attachment source");
      const task = source.findTask
        ? await source.findTask(binding.profile, context.runtimeSessionId)
        : (await source.listTasks(binding.profile)).find((candidate) => candidate.id === context.runtimeSessionId);
      if (!task) {
        throw new Error(
          `This conversation's adopted WorkBuddy Task is unavailable: ${context.runtimeSessionId}; reopen it in WorkBuddy and retry.`,
        );
      }
      return idempotentSession(
        await source.startTask({ profile: binding.profile, taskId: task.id, workspace: task.workspace }),
      );
    },
    close: async () => await source.close?.(),
  };
}

function idempotentSession(session: ConnectRuntimeSession): ConnectRuntimeSession {
  let closed = false;
  const cancel = session.cancel;
  return {
    prompt: (input) => session.prompt(input),
    cancel: cancel ? async () => await cancel() : undefined,
    close: async () => {
      if (closed) return;
      closed = true;
      await session.close();
    },
  };
}

function createDefaultSource(): WorkBuddyRuntimeSource {
  const discoverySource = createWorkBuddyAiMacosDiscoverySource();
  return {
    listTasks: async (profile) => await listWorkBuddyAiTasks(profile),
    findTask: async (profile, taskId) =>
      (await listWorkBuddyAiTasks(profile)).find((candidate) => candidate.id === taskId) ?? null,
    attachTask: async (input) =>
      await attachWorkBuddyTask(
        { profile: input.profile, taskId: input.taskId, expectedWorkspace: input.workspace },
        discoverySource,
      ),
    startTask: async (input) =>
      await connectWorkBuddyTask(
        { profile: input.profile, taskId: input.taskId, expectedWorkspace: input.workspace },
        discoverySource,
      ),
  };
}
