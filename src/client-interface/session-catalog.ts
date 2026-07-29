import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  SessionAction,
  SessionCatalogAction,
  SessionCatalogBindingView,
  SessionCatalogEntryView,
  SessionCatalogView,
  SessionView,
  TurnSubmissionCapability,
} from "../client-contract";
import { getAgentBinding } from "../config";
import { ProjectCatalog } from "../projects";
import { resolveModelSelection } from "../runtime/model-selection";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { SessionActivity } from "../runtime/session-queue";
import type { RuntimeLifecycleCapabilities, RuntimeModelOption, RuntimeThreadSummary } from "../runtime/types";
import { createSessionContinuity, type SessionContinuity } from "../session-continuity";
import type { ConnectStateStore } from "../state";
import type { ConnectConfig, ProjectRecord, RuntimeSessionRecord, RuntimeStatus } from "../types";
import { findProjectForWorkspace, workspaceView } from "../workspace-catalog";
import type { TranscriptProjection } from "./transcript-projection";

const CLIENT_CATALOG_CHAT = "__connect_client_catalog__";

export interface SessionCatalogOptions {
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection: TranscriptProjection;
  projects?: ProjectCatalog;
  sessionActivity?: (bindingId: string, sessionRef: string) => SessionActivity | Promise<SessionActivity>;
  activeTurnId?: (bindingId: string, sessionRef: string) => string | null | Promise<string | null>;
  claimSessionLifecycle?: (bindingId: string, sessionRef: string) => Promise<() => Promise<void>>;
}

interface CatalogState {
  view: SessionCatalogView;
  entriesByRef: Map<string, SessionCatalogEntryView>;
  workingDirectoryByRef: Map<string, string>;
  workspaceIdentityByRef: Map<
    string,
    { bindingId: string; runtimeKind: string; identityKey: string; kind: "persistent" | "transient" }
  >;
  expiresAt: number;
}

export class SessionCatalog {
  private state: CatalogState | null = null;
  private readonly projects: ProjectCatalog;
  private readonly sessionContinuity: SessionContinuity;

  constructor(private readonly options: SessionCatalogOptions) {
    this.projects = options.projects ?? new ProjectCatalog(options.stateStore);
    this.sessionContinuity = createSessionContinuity({
      stateStore: options.stateStore,
      lifecycle: {
        capabilities: (bindingId) =>
          options.runtimeAdapters.lifecycleCapabilities(getAgentBinding(options.config, bindingId)),
        archive: async (bindingId, runtimeThreadId) =>
          await options.runtimeAdapters.archiveThread(getAgentBinding(options.config, bindingId), runtimeThreadId),
        restore: async (bindingId, runtimeThreadId) =>
          await options.runtimeAdapters.unarchiveThread(getAgentBinding(options.config, bindingId), runtimeThreadId),
        delete: async (bindingId, runtimeThreadId) =>
          await options.runtimeAdapters.deleteThread(getAgentBinding(options.config, bindingId), runtimeThreadId),
      },
      claimRuntimeLifecycle: options.claimSessionLifecycle
        ? async (sessionRef) => {
            const session = await options.stateStore.getRuntimeSessionByRef(sessionRef);
            const target = session ? null : await options.stateStore.getSessionRefTarget(sessionRef);
            const bindingId = session?.agentId ?? target?.agentId;
            if (!bindingId) throw new Error(`Session ${sessionRef} was not found`);
            const claim = options.claimSessionLifecycle;
            if (!claim) return async () => undefined;
            return await claim(bindingId, sessionRef);
          }
        : undefined,
    });
  }

  invalidate(): void {
    this.state = null;
  }

  async reconcileLifecycle(): Promise<void> {
    await this.sessionContinuity.reconcileLifecycle();
    this.invalidate();
  }

  async view(force = false): Promise<SessionCatalogView> {
    const cached = (await this.load(force)).view;
    return {
      ...cached,
      bindings: await Promise.all(
        cached.bindings.map(async (binding) => {
          const runtimeStatus = await this.options.stateStore.getRuntimeStatus(binding.bindingId);
          return {
            ...binding,
            entries: await Promise.all(
              binding.entries.map(async (entry) => ({
                ...entry,
                status: sessionStatus(
                  runtimeStatus,
                  (await this.options.sessionActivity?.(binding.bindingId, entry.sessionRef)) ?? "idle",
                ),
              })),
            ),
          };
        }),
      ),
    };
  }

  async entry(sessionRef: string, force = false): Promise<SessionCatalogEntryView | null> {
    return (await this.load(force)).entriesByRef.get(sessionRef.toUpperCase()) ?? null;
  }

  async sessionView(sessionRef: string): Promise<SessionView | null> {
    const normalized = sessionRef.toUpperCase();
    const entry = await this.entry(normalized);
    if (!entry) return null;
    const session = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    const target = session ? null : await this.options.stateStore.getSessionRefTarget(normalized);
    const runtimeThreadAvailable = Boolean(session?.runtimeSessionId || target?.runtimeSessionId);
    const binding = getAgentBinding(this.options.config, entry.bindingId);
    const runtimeStatus = await this.options.stateStore.getRuntimeStatus(entry.bindingId);
    const activity = (await this.options.sessionActivity?.(entry.bindingId, normalized)) ?? "idle";
    const advertisedModels = await this.options.runtimeAdapters.listModels(binding);
    const modelOptions = advertisedModels ?? [];
    let modelAvailable = true;
    let effectiveModel: string | null = null;
    let effectiveReasoningEffort: string | null = null;
    let modelSource: SessionView["modelSource"] = "runtime";
    try {
      const effective = resolveModelSelection(
        binding,
        session ?? { model: null, reasoningEffort: null },
        advertisedModels,
      );
      effectiveModel = effective.model ?? null;
      effectiveReasoningEffort = effective.reasoningEffort ?? null;
      modelSource = effective.source;
    } catch {
      modelAvailable = false;
      effectiveModel = session?.model ?? binding.model ?? null;
      effectiveReasoningEffort = session?.reasoningEffort ?? binding.modelReasoningEffort ?? null;
      modelSource = session?.model ? "session" : binding.model ? "binding" : "runtime";
    }
    const pendingInteractions = await this.options.stateStore.listPendingRuntimeInteractions(normalized);
    const lifecycleCapabilities = this.options.runtimeAdapters.lifecycleCapabilities(binding);
    const effectiveModelOption =
      modelOptions.find((candidate) => candidate.id === effectiveModel) ??
      modelOptions.find((candidate) => candidate.isDefault) ??
      modelOptions[0];
    return {
      revision: Math.max(1, Date.parse(entry.updatedAt) || 1),
      sessionRef: normalized,
      bindingId: entry.bindingId,
      bindingKind: entry.bindingKind,
      projectId: entry.projectId,
      projectName: entry.projectName,
      workspaceName: entry.workspaceName,
      name: entry.name,
      isArchived: entry.isArchived,
      mode: session?.mode ?? null,
      model: session?.model ?? null,
      reasoningEffort: session?.reasoningEffort ?? null,
      effectiveModel,
      effectiveReasoningEffort,
      modelSource,
      modelAvailable,
      modelOptions,
      status: sessionStatus(runtimeStatus, activity),
      runtimeThreadAvailable,
      activeTurnId: (await this.options.activeTurnId?.(entry.bindingId, normalized)) ?? null,
      transcriptCompleteness:
        this.options.transcriptProjection.completeness(normalized) ??
        (runtimeThreadAvailable ? "partial" : "live-only"),
      pendingInteractions,
      turnSubmissionCapability: clientTurnSubmissionCapability(effectiveModelOption, modelAvailable),
      allowedActions: sessionActions(entry.isArchived, runtimeThreadAvailable, activity, lifecycleCapabilities),
      updatedAt: entry.updatedAt,
    };
  }

  async ensureProjection(sessionRef: string, refreshRuntime = false): Promise<boolean> {
    const normalized = sessionRef.toUpperCase();
    const entry = await this.entry(normalized, refreshRuntime);
    if (!entry) return false;
    const session = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    if (session) {
      await this.options.transcriptProjection.reconcile(session, entry.updatedAt);
      return true;
    }
    const target = await this.options.stateStore.getSessionRefTarget(normalized);
    if (!target?.runtimeSessionId) return false;
    await this.options.transcriptProjection.reconcile(
      {
        chatId: target.chatId,
        sessionId: "",
        sessionRef: normalized,
        agentId: target.agentId,
        runtimeSessionId: target.runtimeSessionId,
        projectId: entry.projectId,
        name: entry.name,
        mode: null,
        model: null,
        reasoningEffort: null,
        hasMessages: true,
        isCurrent: false,
        updatedAt: Date.parse(entry.updatedAt) || Date.now(),
      },
      entry.updatedAt,
    );
    return true;
  }

  async adopt(sessionRef: string): Promise<RuntimeSessionRecord | null> {
    const normalized = sessionRef.toUpperCase();
    const state = await this.load();
    const entry = state.entriesByRef.get(normalized) ?? null;
    if (!entry || entry.isArchived) return null;
    const workingDirectory = state.workingDirectoryByRef.get(normalized) ?? null;
    const discoveredProject =
      !entry.projectId && entry.workspaceId && workingDirectory
        ? await this.projects.ensureDiscoveredWorkspace(workingDirectory)
        : null;
    if (discoveredProject) {
      const identity = state.workspaceIdentityByRef.get(normalized);
      if (identity?.kind === "persistent") {
        await this.sessionContinuity.associateWorkspace({ ...identity, projectId: discoveredProject.projectId });
      }
    }
    const existing = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    if (existing) {
      if (!existing.projectId && discoveredProject) {
        await this.sessionContinuity.forSession(existing.sessionRef).associateProject(discoveredProject.projectId);
        this.invalidate();
        return await this.options.stateStore.getRuntimeSessionByRef(normalized);
      }
      return existing;
    }
    const target = await this.options.stateStore.getSessionRefTarget(normalized);
    if (!target?.runtimeSessionId || !entry) return null;
    await this.sessionContinuity.inConversation({ chatId: target.chatId, bindingId: target.agentId }).adopt({
      sessionRef: normalized,
      sessionId: randomUUID(),
      selection: {
        projectId: entry.projectId ?? discoveredProject?.projectId ?? null,
        name: entry.name,
        mode: null,
        model: null,
        reasoningEffort: null,
      },
    });
    this.invalidate();
    return await this.options.stateStore.getRuntimeSessionByRef(normalized);
  }

  async ensureWorkspaceProject(bindingId: string, workspaceId: string): Promise<ProjectRecord | null> {
    const state = await this.load();
    const entry = state.view.bindings
      .find((binding) => binding.bindingId === bindingId)
      ?.entries.find((candidate) => candidate.workspaceId === workspaceId);
    const workingDirectory = entry ? state.workingDirectoryByRef.get(entry.sessionRef.toUpperCase()) : null;
    if (!workingDirectory) return null;
    const project = await this.projects.ensureDiscoveredWorkspace(workingDirectory);
    const identity = entry ? state.workspaceIdentityByRef.get(entry.sessionRef.toUpperCase()) : null;
    if (project && identity?.kind === "persistent") {
      await this.sessionContinuity.associateWorkspace({ ...identity, projectId: project.projectId });
    }
    return project;
  }

  async archive(sessionRef: string): Promise<boolean> {
    const target = await this.runtimeTarget(sessionRef);
    if (!target || target.entry.isArchived) return false;
    await this.sessionContinuity.forSession(target.entry.sessionRef).archive();
    this.invalidate();
    return true;
  }

  async unarchive(sessionRef: string): Promise<boolean> {
    const target = await this.runtimeTarget(sessionRef);
    if (!target?.entry.isArchived) return false;
    await this.sessionContinuity.forSession(target.entry.sessionRef).restore();
    this.invalidate();
    return true;
  }

  async delete(sessionRef: string): Promise<boolean> {
    const target = await this.runtimeTarget(sessionRef);
    if (!target) return false;
    await this.sessionContinuity.forSession(target.entry.sessionRef).delete();
    this.options.transcriptProjection.invalidate(target.entry.sessionRef);
    this.invalidate();
    return true;
  }

  private async runtimeTarget(sessionRef: string) {
    const normalized = sessionRef.toUpperCase();
    const entry = await this.entry(normalized);
    if (!entry) return null;
    const session = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    const refTarget = session ? null : await this.options.stateStore.getSessionRefTarget(normalized);
    const runtimeThreadId = session?.runtimeSessionId ?? refTarget?.runtimeSessionId ?? null;
    if (!runtimeThreadId) return null;
    return {
      entry,
      session,
      runtimeThreadId,
      binding: getAgentBinding(this.options.config, entry.bindingId),
    };
  }

  private async load(force = false): Promise<CatalogState> {
    if (!force && this.state && this.state.expiresAt > Date.now()) return this.state;
    const projects = await this.options.stateStore.listProjects();
    const projectById = new Map(projects.map((project) => [project.projectId, project]));
    const sessions = await this.options.stateStore.listAllRuntimeSessions();
    const bindings: SessionCatalogBindingView[] = [];
    const entriesByRef = new Map<string, SessionCatalogEntryView>();
    const workingDirectoryByRef = new Map<string, string>();
    const workspaceIdentityByRef = new Map<
      string,
      { bindingId: string; runtimeKind: string; identityKey: string; kind: "persistent" | "transient" }
    >();

    for (const [bindingId, binding] of Object.entries(this.options.config.agents)) {
      const lifecycleCapabilities = this.options.runtimeAdapters.lifecycleCapabilities(binding);
      const status = await this.options.stateStore.getRuntimeStatus(bindingId);
      const managed = sessions.filter((session) => session.agentId === bindingId);
      const managedRuntimeIds = new Set(
        managed.map((session) => session.runtimeSessionId).filter((id): id is string => Boolean(id)),
      );
      const discoveredActive = (
        await this.options.runtimeAdapters.discoverAllThreads(getAgentBinding(this.options.config, bindingId))
      ).filter((thread) => !thread.parentRuntimeThreadId);
      const discoveredArchived = (
        await this.options.runtimeAdapters.discoverArchivedThreads(getAgentBinding(this.options.config, bindingId))
      ).filter((thread) => !thread.parentRuntimeThreadId);
      const discovered = [
        ...new Map(
          [...discoveredActive, ...discoveredArchived].map((thread) => [thread.runtimeThreadId, thread]),
        ).values(),
      ];
      const discoveredById = new Map(discovered.map((thread) => [thread.runtimeThreadId, thread]));
      const entries: SessionCatalogEntryView[] = await Promise.all(
        managed.map(async (session) => {
          const project = projectById.get(session.projectId ?? "") ?? null;
          const runtimeThread = session.runtimeSessionId ? discoveredById.get(session.runtimeSessionId) : undefined;
          const workingDirectory = runtimeThread?.workingDirectory ?? null;
          if (workingDirectory) workingDirectoryByRef.set(session.sessionRef.toUpperCase(), workingDirectory);
          const activity = (await this.options.sessionActivity?.(bindingId, session.sessionRef)) ?? "idle";
          return managedEntry(session, binding.kind, project, status, activity, lifecycleCapabilities, runtimeThread);
        }),
      );
      for (const thread of discovered) {
        if (managedRuntimeIds.has(thread.runtimeThreadId)) continue;
        const identity = thread.workspaceIdentity ?? {
          key: thread.workingDirectory ? resolve(thread.workingDirectory) : `thread:${thread.runtimeThreadId}`,
          kind: thread.workspaceKind ?? ("persistent" as const),
          localRoot: thread.workingDirectory ?? null,
        };
        const mapping = await this.options.stateStore.getRuntimeWorkspaceMapping(bindingId, binding.kind, identity.key);
        const project =
          projectById.get(mapping?.projectId ?? "") ??
          (identity.localRoot ? findProjectForWorkspace(projects, identity.localRoot) : null);
        const sessionRef = await this.options.stateStore.getOrCreateSessionRef({
          chatId: CLIENT_CATALOG_CHAT,
          agentId: bindingId,
          runtimeSessionId: thread.runtimeThreadId,
        });
        workspaceIdentityByRef.set(sessionRef.toUpperCase(), {
          bindingId,
          runtimeKind: binding.kind,
          identityKey: identity.key,
          kind: identity.kind,
        });
        if (thread.workingDirectory) workingDirectoryByRef.set(sessionRef.toUpperCase(), thread.workingDirectory);
        const workspace =
          project || thread.workspaceKind !== "transient"
            ? workspaceView(project?.rootPath ?? thread.workingDirectory)
            : null;
        entries.push({
          sessionRef,
          entryKind: "runtime-thread",
          bindingId,
          bindingKind: binding.kind,
          projectId: project?.projectId ?? null,
          projectName: project?.name ?? null,
          workspaceId: workspace?.id ?? null,
          workspaceName: workspace?.name ?? null,
          name: thread.name || `Session ${sessionRef}`,
          isArchived: thread.isArchived === true,
          status: sessionStatus(status, "idle"),
          updatedAt: new Date(thread.updatedAt || Date.now()).toISOString(),
          isCurrent: false,
          isAdopted: false,
          unreadCount: 0,
          pendingInteractionCount: 0,
          allowedActions: catalogActions(thread.isArchived === true, false, true, "idle", lifecycleCapabilities),
        });
      }
      await Promise.all(
        entries.map(async (entry) => {
          entry.pendingInteractionCount = (
            await this.options.stateStore.listPendingRuntimeInteractions(entry.sessionRef)
          ).length;
        }),
      );
      entries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      for (const entry of entries) entriesByRef.set(entry.sessionRef.toUpperCase(), entry);
      bindings.push({
        bindingId,
        displayName: binding.displayName || bindingId,
        kind: binding.kind,
        status:
          status?.websocketConnected == null ? "unknown" : status.websocketConnected ? "connected" : "disconnected",
        entries,
      });
    }
    this.state = {
      view: { revision: Date.now(), bindings },
      entriesByRef,
      workingDirectoryByRef,
      workspaceIdentityByRef,
      expiresAt: Date.now() + 2_000,
    };
    return this.state;
  }
}

function clientTurnSubmissionCapability(
  model: RuntimeModelOption | undefined,
  modelAvailable: boolean,
): TurnSubmissionCapability {
  const modalities = modelAvailable ? (model?.inputModalities ?? ["text"]) : [];
  const native = modelAvailable ? model?.turnSubmissionCapability : undefined;
  const modalityKinds: TurnSubmissionCapability["attachments"]["allowedKinds"] = [];
  if (modalities.includes("image")) modalityKinds.push("image");
  if (modalities.includes("audio")) modalityKinds.push("audio");
  const allowedKinds = (native?.attachments.allowedKinds ?? modalityKinds).filter((kind) =>
    modalityKinds.includes(kind),
  );
  const maxCount = allowedKinds.length > 0 ? Math.min(10, native?.attachments.maxCount ?? 10) : 0;
  return {
    prompt: {
      allowed: modalities.includes("text") && (native?.prompt.allowed ?? true),
      required: native?.prompt.required ?? false,
      maxCharacters: Math.min(64_000, native?.prompt.maxCharacters ?? 64_000),
    },
    attachments: {
      allowedKinds,
      allowedMediaTypes: native?.attachments.allowedMediaTypes ?? allowedKinds.map((kind) => `${kind}/*`),
      maxCount,
      maxBytesEach: Math.min(100 * 1024 * 1024, native?.attachments.maxBytesEach ?? Number.POSITIVE_INFINITY),
      maxBytesTotal: Math.min(100 * 1024 * 1024, native?.attachments.maxBytesTotal ?? Number.POSITIVE_INFINITY),
    },
  };
}

function managedEntry(
  session: RuntimeSessionRecord,
  bindingKind: string,
  project: ProjectRecord | null,
  status: RuntimeStatus | null,
  activity: SessionActivity,
  lifecycleCapabilities: RuntimeLifecycleCapabilities,
  runtimeThread?: RuntimeThreadSummary,
): SessionCatalogEntryView {
  const workspace = workspaceView(
    project?.rootPath ??
      (session.chatId === CLIENT_CATALOG_CHAT && runtimeThread?.workspaceKind !== "transient"
        ? runtimeThread?.workingDirectory
        : null),
  );
  return {
    sessionRef: session.sessionRef,
    entryKind: "session",
    bindingId: session.agentId,
    bindingKind,
    projectId: project?.projectId ?? null,
    projectName: project?.name ?? null,
    workspaceId: workspace?.id ?? null,
    workspaceName: workspace?.name ?? null,
    name: session.name || runtimeThread?.name || `Session ${session.sessionRef}`,
    isArchived: runtimeThread?.isArchived === true,
    status: sessionStatus(status, activity),
    updatedAt: new Date(Math.max(session.updatedAt, runtimeThread?.updatedAt ?? 0)).toISOString(),
    isCurrent: session.isCurrent,
    isAdopted: true,
    unreadCount: 0,
    pendingInteractionCount: 0,
    allowedActions: catalogActions(
      runtimeThread?.isArchived === true,
      true,
      Boolean(session.runtimeSessionId),
      activity,
      lifecycleCapabilities,
    ),
  };
}

function sessionActions(
  isArchived: boolean,
  hasRuntimeThread: boolean,
  activity: SessionActivity,
  capabilities: RuntimeLifecycleCapabilities,
): SessionAction[] {
  return catalogActions(isArchived, true, hasRuntimeThread, activity, capabilities).filter(
    (action): action is SessionAction => action !== "open" && action !== "adopt",
  );
}

function catalogActions(
  isArchived: boolean,
  isAdopted: boolean,
  hasRuntimeThread: boolean,
  activity: SessionActivity,
  capabilities: RuntimeLifecycleCapabilities,
): SessionCatalogAction[] {
  const actions: SessionCatalogAction[] = ["open"];
  if (isArchived) {
    if (activity === "idle" && hasRuntimeThread && capabilities.restore) actions.push("unarchive");
    if (activity === "idle" && hasRuntimeThread && capabilities.delete) actions.push("delete");
    return actions;
  }
  if (isAdopted) {
    actions.push("send");
    if (hasRuntimeThread) actions.push("cancel");
  } else {
    actions.push("adopt");
  }
  if (activity === "idle" && hasRuntimeThread && capabilities.archive) actions.push("archive");
  if (activity === "idle" && hasRuntimeThread && capabilities.delete) actions.push("delete");
  return actions;
}

function sessionStatus(status: RuntimeStatus | null, activity: SessionActivity): SessionCatalogEntryView["status"] {
  if (activity !== "idle") return activity;
  return status?.websocketConnected === false ? "offline" : "idle";
}
