import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  SessionCatalogBindingView,
  SessionCatalogEntryView,
  SessionCatalogView,
  SessionView,
} from "../client-contract";
import { getAgentBinding } from "../config";
import { ProjectCatalog } from "../projects";
import { resolveModelSelection } from "../runtime/model-selection";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { SessionActivity } from "../runtime/session-queue";
import type { RuntimeThreadSummary } from "../runtime/types";
import type { ConnectStateStore } from "../state";
import type { ConnectConfig, ProjectRecord, RuntimeSessionRecord, RuntimeStatus } from "../types";
import type { TranscriptProjection } from "./transcript-projection";

const CLIENT_CATALOG_CHAT = "__connect_client_catalog__";

export interface SessionCatalogOptions {
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection: TranscriptProjection;
  projects?: ProjectCatalog;
  sessionActivity?: (bindingId: string, sessionRef: string) => SessionActivity | Promise<SessionActivity>;
}

interface CatalogState {
  view: SessionCatalogView;
  entriesByRef: Map<string, SessionCatalogEntryView>;
  workingDirectoryByRef: Map<string, string>;
  expiresAt: number;
}

export class SessionCatalog {
  private state: CatalogState | null = null;
  private readonly projects: ProjectCatalog;

  constructor(private readonly options: SessionCatalogOptions) {
    this.projects = options.projects ?? new ProjectCatalog(options.stateStore);
  }

  invalidate(): void {
    this.state = null;
  }

  async view(force = false): Promise<SessionCatalogView> {
    return (await this.load(force)).view;
  }

  async entry(sessionRef: string): Promise<SessionCatalogEntryView | null> {
    return (await this.load()).entriesByRef.get(sessionRef.toUpperCase()) ?? null;
  }

  async sessionView(sessionRef: string): Promise<SessionView | null> {
    const normalized = sessionRef.toUpperCase();
    const entry = await this.entry(normalized);
    if (!entry) return null;
    const session = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    const target = session ? null : await this.options.stateStore.getSessionRefTarget(normalized);
    const runtimeThreadAvailable = Boolean(session?.runtimeSessionId || target?.runtimeSessionId);
    const binding = getAgentBinding(this.options.config, entry.bindingId);
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
      status: entry.status,
      runtimeThreadAvailable,
      activeTurnId: null,
      transcriptCompleteness:
        this.options.transcriptProjection.completeness(normalized) ??
        (runtimeThreadAvailable ? "partial" : "live-only"),
      pendingInteractions,
      allowedActions: entry.isArchived
        ? ["unarchive", "delete"]
        : entry.isAdopted
          ? ["send", "cancel", "archive", "delete"]
          : ["send", "archive", "delete"],
      updatedAt: entry.updatedAt,
    };
  }

  async ensureProjection(sessionRef: string): Promise<boolean> {
    const normalized = sessionRef.toUpperCase();
    const entry = await this.entry(normalized);
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
    const existing = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    if (existing) {
      if (!existing.projectId && discoveredProject) {
        await this.options.stateStore.setRuntimeSessionProject(
          existing.chatId,
          existing.agentId,
          existing.sessionId,
          discoveredProject.projectId,
        );
        this.invalidate();
        return await this.options.stateStore.getRuntimeSessionByRef(normalized);
      }
      return existing;
    }
    const target = await this.options.stateStore.getSessionRefTarget(normalized);
    if (!target?.runtimeSessionId || !entry) return null;
    const sessionId = randomUUID();
    await this.options.stateStore.upsertRuntimeSession({
      chatId: target.chatId,
      sessionId,
      agentId: target.agentId,
      runtimeSessionId: target.runtimeSessionId,
      projectId: entry.projectId ?? discoveredProject?.projectId ?? null,
      name: entry.name,
      hasMessages: true,
      isCurrent: true,
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
    return workingDirectory ? await this.projects.ensureDiscoveredWorkspace(workingDirectory) : null;
  }

  async archive(sessionRef: string): Promise<boolean> {
    const target = await this.runtimeTarget(sessionRef);
    if (!target || target.entry.isArchived) return false;
    await this.options.runtimeAdapters.archiveThread(target.binding, target.runtimeThreadId);
    if (target.session?.isCurrent) {
      await this.options.stateStore.setSessionIntent({
        chatId: target.session.chatId,
        agentId: target.session.agentId,
        projectId: target.session.projectId,
        name: target.session.name,
        mode: target.session.mode,
        model: target.session.model,
        reasoningEffort: target.session.reasoningEffort,
      });
    }
    this.invalidate();
    return true;
  }

  async unarchive(sessionRef: string): Promise<boolean> {
    const target = await this.runtimeTarget(sessionRef);
    if (!target?.entry.isArchived) return false;
    await this.options.runtimeAdapters.unarchiveThread(target.binding, target.runtimeThreadId);
    this.invalidate();
    return true;
  }

  async delete(sessionRef: string): Promise<boolean> {
    const target = await this.runtimeTarget(sessionRef);
    if (!target) return false;
    await this.options.runtimeAdapters.deleteThread(target.binding, target.runtimeThreadId);
    if (target.session?.isCurrent) {
      await this.options.stateStore.setSessionIntent({
        chatId: target.session.chatId,
        agentId: target.session.agentId,
        projectId: target.session.projectId,
        name: target.session.name,
        mode: target.session.mode,
        model: target.session.model,
        reasoningEffort: target.session.reasoningEffort,
      });
    }
    const deleted = await this.options.stateStore.deleteSessionByRef(target.entry.sessionRef);
    this.options.transcriptProjection.invalidate(target.entry.sessionRef);
    this.invalidate();
    return deleted;
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

    for (const [bindingId, binding] of Object.entries(this.options.config.agents)) {
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
          return managedEntry(session, binding.kind, project, status, activity, runtimeThread);
        }),
      );
      for (const thread of discovered) {
        if (managedRuntimeIds.has(thread.runtimeThreadId)) continue;
        const project = thread.workingDirectory ? findProjectForWorkspace(projects, thread.workingDirectory) : null;
        const sessionRef = await this.options.stateStore.getOrCreateSessionRef({
          chatId: CLIENT_CATALOG_CHAT,
          agentId: bindingId,
          runtimeSessionId: thread.runtimeThreadId,
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
          allowedActions: thread.isArchived ? ["open", "unarchive", "delete"] : ["open", "adopt", "archive", "delete"],
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
      expiresAt: Date.now() + 2_000,
    };
    return this.state;
  }
}

function managedEntry(
  session: RuntimeSessionRecord,
  bindingKind: string,
  project: ProjectRecord | null,
  status: RuntimeStatus | null,
  activity: SessionActivity,
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
    allowedActions: runtimeThread?.isArchived
      ? ["open", "unarchive", "delete"]
      : ["open", "send", "cancel", "archive", "delete"],
  };
}

function workspaceView(workingDirectory: string | null | undefined): { id: string; name: string } | null {
  if (!workingDirectory) return null;
  const root = resolve(workingDirectory);
  const name = basename(root) || root;
  const parentName = basename(dirname(root));
  return {
    id: createHash("sha256").update(root).digest("hex").slice(0, 24),
    name: /^\d{4}-\d{2}-\d{2}$/u.test(parentName) ? `${parentName}/${name}` : name,
  };
}

function findProjectForWorkspace(projects: ProjectRecord[], workingDirectory: string): ProjectRecord | null {
  const workspace = resolve(workingDirectory);
  return (
    projects
      .filter((project) => pathContains(resolve(project.rootPath), workspace))
      .sort((left, right) => resolve(right.rootPath).length - resolve(left.rootPath).length)[0] ?? null
  );
}

function pathContains(root: string, candidate: string): boolean {
  const nestedPath = relative(root, candidate);
  return nestedPath === "" || (!nestedPath.startsWith("..") && !isAbsolute(nestedPath));
}

function sessionStatus(status: RuntimeStatus | null, activity: SessionActivity): SessionCatalogEntryView["status"] {
  if (activity !== "idle") return activity;
  return status?.websocketConnected === false ? "offline" : "idle";
}
