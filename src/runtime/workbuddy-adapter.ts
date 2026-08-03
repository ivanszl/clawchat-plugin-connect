import { isDeepStrictEqual } from "node:util";
import type { AgentBindingConfig } from "../types";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  RuntimeActivity,
  RuntimeActivitySnapshot,
  RuntimeCatalogScope,
  RuntimeInteractionPort,
} from "./types";
import {
  type WorkBuddyAcpTaskAttachment,
  WorkBuddyPromptTransportError,
  type WorkBuddyTaskCatalog,
} from "./workbuddy-acp-client";
import {
  workBuddySubmittedUserHistoryActivityId,
  workBuddySubmittedUserLiveActivityId,
} from "./workbuddy-activity-identity";
import type { WorkBuddyEndpointVerification } from "./workbuddy-task-discovery";
import { attachWorkBuddyTask, connectWorkBuddyTask, type WorkBuddyProfile } from "./workbuddy-task-discovery";
import { createWorkBuddyMacosDiscoverySource, listWorkBuddyTasks } from "./workbuddy-task-discovery-macos";

export interface WorkBuddyTaskSummary {
  id: string;
  title: string | null;
  workspace: string;
  updatedAt: number;
}

export interface WorkBuddyRuntimeSource {
  listTasks(profile: WorkBuddyProfile): Promise<WorkBuddyTaskSummary[]>;
  findTask?(profile: WorkBuddyProfile, taskId: string): Promise<WorkBuddyTaskSummary | null>;
  attachTask(input: {
    profile: WorkBuddyProfile;
    taskId: string;
    workspace: string;
  }): Promise<RuntimeActivitySnapshot & { catalog?: WorkBuddyTaskCatalog }>;
  startTask?(input: {
    profile: WorkBuddyProfile;
    taskId: string;
    workspace: string;
  }): Promise<WorkBuddyAcpTaskAttachment>;
  close?(): Promise<void>;
}

export interface WorkBuddyRuntimeAdapterOptions {
  createSource?: () => WorkBuddyRuntimeSource;
}

export type WorkBuddyPromptRecoveryFailureCode =
  | "prompt-not-committed"
  | "prompt-failed"
  | "prompt-outcome-indeterminate";

export class WorkBuddyPromptRecoveryError extends Error {
  readonly name = "WorkBuddyPromptRecoveryError";

  constructor(
    readonly code: WorkBuddyPromptRecoveryFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function createWorkBuddyRuntimeAdapter(options: WorkBuddyRuntimeAdapterOptions = {}): ConnectRuntimeAdapter {
  const source = (options.createSource ?? createDefaultSource)();
  const catalogs = new Map<string, WorkBuddyTaskCatalog>();
  const catalogListeners = new Set<() => void>();
  const catalogSubscriptions = new Set<() => void>();
  const publishCatalog = (taskId: string, attachment: WorkBuddyAcpTaskAttachment): (() => void) => {
    const initialCatalog = attachment.catalog;
    const onCatalogChanged = attachment.onCatalogChanged;
    if (!initialCatalog) return () => undefined;
    const update = () => {
      const current = attachment.catalog;
      if (!current) return;
      catalogs.set(taskId, current);
      for (const listener of catalogListeners) listener();
    };
    update();
    if (!onCatalogChanged) return () => undefined;
    const unsubscribe = onCatalogChanged(update);
    const release = () => {
      unsubscribe();
      catalogSubscriptions.delete(release);
    };
    catalogSubscriptions.add(release);
    return release;
  };
  const catalogFor = async (
    binding: AgentBindingConfig,
    scope?: RuntimeCatalogScope,
  ): Promise<WorkBuddyTaskCatalog> => {
    const taskId = scope?.runtimeThreadId;
    if (!taskId) return emptyCatalog();
    const cached = catalogs.get(taskId);
    if (cached) return cached;
    const profile = requireWorkBuddyProfile(binding);
    const task = await resolveTask(source, profile, taskId);
    if (!task) throw new Error(`WorkBuddy Task was not found: ${taskId}`);
    if (!source.startTask)
      throw new Error("WorkBuddy Task capability discovery is unavailable for this Attachment source");
    const attachment = await source.startTask({ profile, taskId, workspace: task.workspace });
    try {
      const catalog = attachment.catalog;
      if (!catalog) throw new Error("WorkBuddy Task capability discovery returned no Task catalog");
      catalogs.set(taskId, catalog);
      return catalog;
    } finally {
      await attachment.close();
    }
  };
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
    const profile = requireWorkBuddyProfile(binding);
    const task = await resolveTask(source, profile, runtimeThreadId);
    if (!task) throw new Error(`WorkBuddy Task was not found: ${runtimeThreadId}`);
    const loaded = await source.attachTask({
      profile,
      taskId: task.id,
      workspace: task.workspace,
    });
    if (loaded.catalog) {
      catalogs.set(task.id, loaded.catalog);
      for (const listener of catalogListeners) listener();
    }
    return loaded;
  };
  return {
    kind: "workbuddy",
    modes: [],
    prepare: async (binding) => {
      await source.listTasks(requireWorkBuddyProfile(binding));
    },
    modesFor: (_binding, scope) =>
      scope?.runtimeThreadId ? (catalogs.get(scope.runtimeThreadId)?.modes.map((mode) => mode.id) ?? []) : [],
    lifecycleCapabilities: { archive: false, restore: false, delete: false },
    listModels: async (binding, scope) => (await catalogFor(binding, scope)).models,
    listSessionOptions: async (binding, _workspace, scope) => (await catalogFor(binding, scope)).configOptions,
    listSkills: async (binding, workspace, listOptions) =>
      (
        await catalogFor(binding, {
          runtimeThreadId: listOptions?.runtimeThreadId,
          workspace,
        })
      ).skills.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })),
    onSkillsChanged: (listener) => {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
    listCommands: async (binding, workspace, listOptions) =>
      (
        await catalogFor(binding, {
          runtimeThreadId: listOptions?.runtimeThreadId,
          workspace,
        })
      ).commands.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })),
    onCommandsChanged: (listener) => {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
    onCatalogsChanged: (listener) => {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
    discoverAllThreads,
    discoverThreads: async (binding, workspace) =>
      (await discoverAllThreads(binding)).filter((thread) => thread.workingDirectory === workspace.workingDirectory),
    verifyThreadReady: async (binding, runtimeThreadId) => void (await attachTask(binding, runtimeThreadId)),
    readActivity: attachTask,
    start: async (binding, context) => {
      const profile = requireWorkBuddyProfile(binding);
      if (!context.runtimeSessionId) {
        throw new Error(
          "This conversation is not mapped to a WorkBuddy Task; adopt an existing WorkBuddy Task before submitting a turn.",
        );
      }
      const startTask = source.startTask;
      if (!startTask) throw new Error("WorkBuddy Task turn submission is unavailable for this Attachment source");
      const task = await resolveTask(source, profile, context.runtimeSessionId);
      if (!task) {
        throw new Error(
          `This conversation's adopted WorkBuddy Task is unavailable: ${context.runtimeSessionId}; reopen it in WorkBuddy and retry.`,
        );
      }
      let releaseCatalog: () => void = () => undefined;
      const reconnect = async (): Promise<WorkBuddyAcpTaskAttachment> => {
        const rediscovered = await resolveTask(source, profile, task.id);
        if (!rediscovered) {
          throw new Error(
            `This conversation's adopted WorkBuddy Task is unavailable: ${task.id}; reopen it in WorkBuddy and retry.`,
          );
        }
        const attachment = await startTask({
          profile,
          taskId: rediscovered.id,
          workspace: rediscovered.workspace,
        });
        releaseCatalog();
        releaseCatalog = publishCatalog(task.id, attachment);
        return attachment;
      };
      return recoverableSession(await reconnect(), reconnect, () => releaseCatalog());
    },
    close: async () => {
      for (const unsubscribe of [...catalogSubscriptions]) unsubscribe();
      catalogListeners.clear();
      catalogs.clear();
      await source.close?.();
    },
  };
}

function emptyCatalog(): WorkBuddyTaskCatalog {
  return {
    models: [],
    currentModelId: null,
    modes: [],
    currentModeId: null,
    configOptions: [],
    currentConfig: {},
    commands: [],
    skills: [],
  };
}

async function resolveTask(
  source: WorkBuddyRuntimeSource,
  profile: WorkBuddyProfile,
  taskId: string,
): Promise<WorkBuddyTaskSummary | null> {
  return source.findTask
    ? await source.findTask(profile, taskId)
    : ((await source.listTasks(profile)).find((candidate) => candidate.id === taskId) ?? null);
}

function requireWorkBuddyProfile(binding: AgentBindingConfig): WorkBuddyProfile {
  if (binding.kind !== "workbuddy") throw new Error("WorkBuddy Runtime Adapter requires a WorkBuddy Binding");
  return binding.profile;
}

function recoverableSession(
  initialSession: WorkBuddyAcpTaskAttachment,
  reconnect: () => Promise<WorkBuddyAcpTaskAttachment>,
  releaseCatalog: () => void = () => undefined,
): ConnectRuntimeSession {
  let session: WorkBuddyAcpTaskAttachment | null = initialSession;
  let closed = false;
  let activeTurnAbort: AbortController | null = null;
  const knownActivities = new Map(
    verificationActivities(initialSession).map((activity) => [activity.id, activity] as const),
  );
  return {
    prompt: async function* (input) {
      if (closed) throw new Error("WorkBuddy Task Attachment is closed");
      const connectionWasLost = session === null;
      const active = session ?? (await reconnect());
      session = active;
      const attachmentHistory = verificationActivities(active);
      if (connectionWasLost) {
        for (const activity of recoveredNativeActivities(attachmentHistory, knownActivities)) {
          knownActivities.set(activity.id, activity);
          yield activity;
        }
      }
      for (const activity of attachmentHistory) knownActivities.set(activity.id, activity);
      let accepted = false;
      const turnAbort = new AbortController();
      activeTurnAbort = turnAbort;
      const trackedInput: ConnectRuntimePrompt = {
        ...input,
        interactionPort: expiringInteractionPort(input.interactionPort, turnAbort.signal),
        onAccepted: async () => {
          accepted = true;
          await input.onAccepted?.();
        },
      };
      try {
        for await (const activity of active.prompt(trackedInput)) {
          knownActivities.set(activity.id, activity);
          yield activity;
        }
      } catch (error) {
        turnAbort.abort("WorkBuddy Task Attachment was lost");
        if (session === active) session = null;
        await active.close().catch(() => undefined);
        if (!accepted && !(error instanceof WorkBuddyPromptTransportError)) throw error;
        let recovered: WorkBuddyAcpTaskAttachment;
        try {
          recovered = await reconnect();
        } catch (recoveryError) {
          throw new WorkBuddyPromptRecoveryError(
            "prompt-outcome-indeterminate",
            "WorkBuddy disconnected after possible prompt acceptance, and authoritative history could not be reloaded; the outcome is indeterminate and was not retried.",
            { cause: recoveryError },
          );
        }
        if (closed) {
          await recovered.close().catch(() => undefined);
          throw new Error("WorkBuddy Task Attachment is closed");
        }
        session = recovered;
        const history = verificationActivities(recovered);
        const outcome = reconcilePromptOutcome(history, input, knownActivities);
        for (const activity of outcome.activities) {
          knownActivities.set(activity.id, activity);
          yield activity;
        }
        for (const activity of history) knownActivities.set(activity.id, activity);
        if (outcome.state === "completed") return;
        if (outcome.state === "not-committed") {
          throw new WorkBuddyPromptRecoveryError(
            "prompt-not-committed",
            "WorkBuddy authoritative history proves the disconnected prompt was not committed; it was not retried.",
            { cause: error },
          );
        }
        if (outcome.state === "failed") {
          throw new WorkBuddyPromptRecoveryError(
            "prompt-failed",
            "WorkBuddy authoritative history proves the disconnected prompt failed; it was not retried.",
            { cause: error },
          );
        }
        throw new WorkBuddyPromptRecoveryError(
          "prompt-outcome-indeterminate",
          "WorkBuddy authoritative history contains the disconnected prompt but no completed assistant result; the outcome is indeterminate and was not retried.",
          { cause: error },
        );
      } finally {
        turnAbort.abort("WorkBuddy turn ended");
        if (activeTurnAbort === turnAbort) activeTurnAbort = null;
      }
    },
    cancel: async () => (await session?.cancel?.()) ?? false,
    close: async () => {
      if (closed) return;
      closed = true;
      activeTurnAbort?.abort("WorkBuddy Task Attachment was closed");
      activeTurnAbort = null;
      const active = session;
      session = null;
      try {
        await active?.close();
      } finally {
        releaseCatalog();
      }
    },
  };
}

function verificationActivities(session: WorkBuddyAcpTaskAttachment): RuntimeActivity[] {
  const verification: WorkBuddyEndpointVerification = session.verification;
  return verification?.replayStarted && verification.replayCompleted ? verification.activities : [];
}

function reconcilePromptOutcome(
  history: RuntimeActivity[],
  input: ConnectRuntimePrompt,
  knownActivities: ReadonlyMap<string, RuntimeActivity>,
): {
  state: "completed" | "failed" | "not-committed" | "indeterminate";
  activities: RuntimeActivity[];
} {
  const submittedId = workBuddySubmittedUserHistoryActivityId(input);
  const submittedIndex = submittedId ? history.findIndex((activity) => activity.id === submittedId) : -1;
  const nextUserIndex =
    submittedIndex < 0
      ? -1
      : history.findIndex((activity, index) => index > submittedIndex && activity.kind === "user");
  const turnEnd = nextUserIndex < 0 ? history.length : nextUserIndex;
  const completed =
    submittedIndex >= 0 &&
    history
      .slice(submittedIndex + 1, turnEnd)
      .some((activity) => activity.kind === "assistant" && activity.state === "complete");
  const failed =
    submittedIndex >= 0 &&
    history
      .slice(submittedIndex + 1, turnEnd)
      .some((activity) => activity.kind === "error" || activity.state === "error" || activity.state === "cancelled");
  const activities = history
    .map((activity, index) => ({ activity, index }))
    .map(({ activity, index }) => ({
      activity: index === submittedIndex ? correlateRecoveredSubmittedActivity(activity, input) : activity,
      index,
    }))
    .filter(({ activity }) => !isDeepStrictEqual(knownActivities.get(activity.id), activity))
    .map(({ activity, index }) =>
      submittedIndex >= 0 && index >= submittedIndex && index < turnEnd
        ? activity
        : recoveredProjectionOnlyActivity(activity),
    );
  return {
    state: completed ? "completed" : failed ? "failed" : submittedIndex < 0 ? "not-committed" : "indeterminate",
    activities,
  };
}

function recoveredNativeActivities(
  history: RuntimeActivity[],
  knownActivities: ReadonlyMap<string, RuntimeActivity>,
): RuntimeActivity[] {
  return history
    .filter((activity) => !isDeepStrictEqual(knownActivities.get(activity.id), activity))
    .map(recoveredProjectionOnlyActivity);
}

function recoveredProjectionOnlyActivity(activity: RuntimeActivity): RuntimeActivity {
  return {
    ...activity,
    data: {
      ...activity.data,
      recoveredWhileDisconnected: true,
      deliveryDisposition: "projection-only",
    },
  };
}

function correlateRecoveredSubmittedActivity(activity: RuntimeActivity, input: ConnectRuntimePrompt): RuntimeActivity {
  const liveSubmittedId = workBuddySubmittedUserLiveActivityId(input);
  return {
    ...activity,
    ...(liveSubmittedId ? { aliases: [...new Set([...(activity.aliases ?? []), liveSubmittedId])] } : {}),
    data: {
      ...activity.data,
      ...(input.turnId
        ? input.turnOrigin === "clawchat"
          ? { clawchatMessageId: input.turnId }
          : { clientMessageId: `turn_${input.turnId}_user` }
        : {}),
    },
  };
}

function expiringInteractionPort(
  interactionPort: RuntimeInteractionPort | undefined,
  attachmentSignal: AbortSignal,
): RuntimeInteractionPort | undefined {
  if (!interactionPort) return undefined;
  return {
    request: async (request, context) =>
      await interactionPort.request(request, {
        ...context,
        signal: context.signal ? AbortSignal.any([context.signal, attachmentSignal]) : attachmentSignal,
      }),
  };
}

function createDefaultSource(): WorkBuddyRuntimeSource {
  const discoverySources = new Map<WorkBuddyProfile, ReturnType<typeof createWorkBuddyMacosDiscoverySource>>();
  const discoverySource = (profile: WorkBuddyProfile) => {
    let source = discoverySources.get(profile);
    if (!source) {
      source = createWorkBuddyMacosDiscoverySource(profile);
      discoverySources.set(profile, source);
    }
    return source;
  };
  return {
    listTasks: async (profile) => await listWorkBuddyTasks(profile),
    findTask: async (profile, taskId) =>
      (await listWorkBuddyTasks(profile)).find((candidate) => candidate.id === taskId) ?? null,
    attachTask: async (input) =>
      await attachWorkBuddyTask(
        { profile: input.profile, taskId: input.taskId, expectedWorkspace: input.workspace },
        discoverySource(input.profile),
      ),
    startTask: async (input) =>
      await connectWorkBuddyTask(
        { profile: input.profile, taskId: input.taskId, expectedWorkspace: input.workspace },
        discoverySource(input.profile),
      ),
  };
}
