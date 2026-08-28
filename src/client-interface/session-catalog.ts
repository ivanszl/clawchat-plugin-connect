import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  QueuedTurnView,
  RuntimeThreadUnavailableReasonView,
  SessionAction,
  SessionCatalogAction,
  SessionCatalogBindingView,
  SessionCatalogEntryView,
  SessionCatalogView,
  SessionView,
  TurnSubmissionCapability,
} from "../client-contract";
import { getAgentBinding } from "../config";
import type { ConnectStateStore } from "../persistence/state";
import { resolveModelSelection, runtimeModelSelectionsEqual } from "../runtime/model-selection";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { SessionActivity } from "../runtime/session-queue";
import type {
  RuntimeLifecycleCapabilities,
  RuntimeModelOption,
  RuntimeThreadCandidate,
  RuntimeThreadDiscoverySnapshot,
} from "../runtime/types";
import {
  type WorkBuddyCapabilityFailure,
  workBuddyCapabilityAvailability,
  workBuddyCapabilityFailure,
} from "../runtime/workbuddy-availability";
import { isCodeBuddySessionRuntimeTarget } from "../runtime/workbuddy-runtime-target";
import type {
  AgentBindingConfig,
  ConnectConfig,
  RuntimeModelSelection,
  RuntimeSessionRecord,
  RuntimeStatus,
  RuntimeWorkspace,
  WorkspaceRecord,
} from "../types";
import {
  createSessionContinuity,
  type SessionContinuity,
  type SessionContinuityModule,
  type SessionContinuityOptions,
} from "../workspaces/session-continuity";
import { synchronizeRuntimeWorkspaces } from "../workspaces/workspace-synchronizer";
import { WorkspaceCatalog } from "../workspaces/workspaces";
import type { TranscriptProjection } from "./transcript-projection";

const CLIENT_CATALOG_CHAT = "__connect_client_catalog__";

export interface SessionCatalogOptions {
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  runtimeFamily?: (binding: AgentBindingConfig) => string | Promise<string>;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection: TranscriptProjection;
  workspaces?: WorkspaceCatalog;
  sessionContinuityModule?: SessionContinuityModule;
  sessionActivity?: (bindingId: string, sessionRef: string) => SessionActivity | Promise<SessionActivity>;
  activeTurnId?: (bindingId: string, sessionRef: string) => string | null | Promise<string | null>;
  queuedTurns?: (bindingId: string, sessionRef: string) => QueuedTurnView[] | Promise<QueuedTurnView[]>;
  claimSessionLifecycle?: (bindingId: string, sessionRef: string) => Promise<() => Promise<void>>;
}

interface CatalogState {
  view: SessionCatalogView;
  entriesByRef: Map<string, SessionCatalogEntryView>;
  workingDirectoryByRef: Map<string, string>;
  runtimeRevisionByRef: Map<string, string>;
  expiresAt: number;
}

export class SessionCatalog {
  private state: CatalogState | null = null;
  private runtimeWorkspaceLocationCache: Array<{ name: string; path: string }> = [];
  private readonly workspaces: WorkspaceCatalog;
  private readonly sessionContinuity: SessionContinuity;

  constructor(private readonly options: SessionCatalogOptions) {
    this.workspaces = options.workspaces ?? new WorkspaceCatalog(options.stateStore);
    const continuityOptions: Omit<SessionContinuityOptions, "stateStore"> = {
      lifecycle: {
        capabilities: (bindingId) => {
          const binding = getAgentBinding(options.config, bindingId);
          return options.runtimeAdapters.hasProvider(binding)
            ? options.runtimeAdapters.lifecycleCapabilities(binding)
            : { archive: false, restore: false, delete: false };
        },
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
      resolveDefaultWorkspace: async (bindingId) => (await this.workspaces.ensureDefault(bindingId)).workspaceRef,
      resolveContinuationWorkspace: async (source, bindingId) => {
        if (source.agentId === bindingId && source.workspaceRef) return source.workspaceRef;
        const sourceWorkspace = source.workspaceRef
          ? await this.workspaces.get(source.agentId, source.workspaceRef)
          : null;
        if (sourceWorkspace) {
          const target = (await this.workspaces.list(bindingId)).find(
            (workspace) => resolve(workspace.rootPath) === resolve(sourceWorkspace.rootPath),
          );
          if (target) return target.workspaceRef;
        }
        return (await this.workspaces.ensureDefault(bindingId)).workspaceRef;
      },
    };
    this.sessionContinuity =
      options.sessionContinuityModule?.create(continuityOptions) ??
      createSessionContinuity({ ...continuityOptions, stateStore: options.stateStore });
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
          const providerAvailable = this.options.runtimeAdapters.hasProvider(
            getAgentBinding(this.options.config, binding.bindingId),
          );
          return {
            ...binding,
            entries: await Promise.all(
              binding.entries.map(async (entry) => ({
                ...entry,
                status:
                  entry.status === "offline" || entry.status === "error"
                    ? entry.status
                    : providerAvailable
                      ? sessionStatus(
                          runtimeStatus,
                          (await this.options.sessionActivity?.(binding.bindingId, entry.sessionRef)) ?? "idle",
                        )
                      : "offline",
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

  async runtimeWorkspaceLocations(): Promise<Array<{ name: string; path: string }>> {
    return this.runtimeWorkspaceLocationCache.map((location) => ({ ...location }));
  }

  private rememberRuntimeWorkspaceLocations(state: CatalogState): void {
    const locations = new Map<string, { name: string; path: string }>();
    for (const [sessionRef, path] of state.workingDirectoryByRef) {
      const entry = state.entriesByRef.get(sessionRef);
      locations.set(resolve(path), { name: entry?.workspaceName || resolve(path), path });
    }
    this.runtimeWorkspaceLocationCache = [...locations.values()];
  }

  async workspace(sessionRef: string): Promise<RuntimeWorkspace | null> {
    const normalized = sessionRef.toUpperCase();
    const state = await this.load();
    const entry = state.entriesByRef.get(normalized) ?? null;
    if (!entry) return null;
    const managed = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    if (managed) return await this.workspaces.resolveWorkspace(managed);
    return await this.workspaces.resolveWorkspaceRef(entry.bindingId, entry.workspaceRef).catch(() => null);
  }

  async sessionView(sessionRef: string): Promise<SessionView | null> {
    const normalized = sessionRef.toUpperCase();
    const catalogState = await this.load();
    const entry = catalogState.entriesByRef.get(normalized) ?? null;
    if (!entry) return null;
    const session = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    const target = session ? null : await this.options.stateStore.getSessionRefTarget(normalized);
    const hasMappedRuntimeThread = Boolean(session?.runtimeSessionId || target?.runtimeSessionId);
    const hasPersistedMappedSession = Boolean(session?.runtimeSessionId);
    const runtimeThreadPresent = hasMappedRuntimeThread && catalogState.runtimeRevisionByRef.has(normalized);
    const runtimeThreadAvailable = runtimeThreadPresent && entry.runtimeThreadUnavailableReason === null;
    const runtimeThreadMissing = hasMappedRuntimeThread && !runtimeThreadPresent;
    const bindingLockReason = session
      ? await this.options.stateStore.sessionBindingLock(normalized)
      : hasMappedRuntimeThread
        ? ("runtime-thread" as const)
        : null;
    const binding = getAgentBinding(this.options.config, entry.bindingId);
    const runtimeStatus = await this.options.stateStore.getRuntimeStatus(entry.bindingId);
    const activity = (await this.options.sessionActivity?.(entry.bindingId, normalized)) ?? "idle";
    const runtimeThreadId = session?.runtimeSessionId ?? target?.runtimeSessionId ?? undefined;
    const runtimeWorkspace = session ? await this.workspaces.resolveWorkspace(session) : undefined;
    const catalogScope = { runtimeThreadId, workspace: runtimeWorkspace };
    const providerAvailable = this.options.runtimeAdapters.hasProvider(binding);
    const runtimeOperational =
      providerAvailable &&
      runtimeStatus?.runtimeAvailability !== "startup-unavailable" &&
      runtimeStatus?.websocketConnected !== false &&
      entry.status !== "offline" &&
      entry.status !== "error" &&
      (entry.runtimeThreadUnavailableReason === null || entry.runtimeThreadUnavailableReason === "archived");
    let advertisedModels: Awaited<ReturnType<RuntimeAdapterRegistry["listModels"]>> = null;
    if (runtimeOperational) {
      try {
        advertisedModels = await this.options.runtimeAdapters.listModels(binding, catalogScope);
      } catch (error) {
        if (this.options.runtimeAdapters.familyFor(binding) !== "workbuddy") throw error;
      }
    }
    const modelOptions = advertisedModels ?? [];
    const selectedSessionOptions = {
      ...(binding.sessionOptions ?? {}),
      ...(session?.sessionOptions ?? {}),
    };
    let advertisedSessionOptions: Awaited<ReturnType<RuntimeAdapterRegistry["listSessionOptions"]>> = [];
    if (session && runtimeWorkspace && runtimeOperational) {
      try {
        advertisedSessionOptions = await this.options.runtimeAdapters.listSessionOptions(
          binding,
          runtimeWorkspace,
          catalogScope,
        );
      } catch (error) {
        if (this.options.runtimeAdapters.familyFor(binding) !== "workbuddy") throw error;
      }
    }
    const sessionOptionDefinitions = advertisedSessionOptions.map((option) => {
      const selected = selectedSessionOptions[option.id];
      return selected && !option.values.some((value) => value.id === selected)
        ? {
            ...option,
            values: [
              { id: selected, displayName: selected, description: "Saved selection is unavailable", unavailable: true },
              ...option.values,
            ],
          }
        : option;
    });
    for (const [id, selected] of Object.entries(selectedSessionOptions)) {
      if (sessionOptionDefinitions.some((definition) => definition.id === id)) continue;
      sessionOptionDefinitions.push({
        id,
        displayName: id,
        description: "Saved Runtime Adapter option is no longer advertised",
        category: "other",
        changePolicy: "in-place",
        values: [{ id: selected, displayName: selected, unavailable: true }],
      });
    }
    let modelAvailable = true;
    let effectiveModel: RuntimeModelSelection | null = null;
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
    const lifecycleCapabilities = providerAvailable
      ? this.options.runtimeAdapters.lifecycleCapabilities(binding)
      : { archive: false, restore: false, delete: false };
    const recoverableMappedSession = hasPersistedMappedSession && lifecycleCapabilities.recoverMissing === true;
    const canSubmit = !hasMappedRuntimeThread || runtimeThreadAvailable || recoverableMappedSession;
    const effectiveModelOption =
      modelOptions.find((candidate) => runtimeModelSelectionsEqual(candidate.selection, effectiveModel)) ??
      modelOptions.find((candidate) => candidate.isDefault) ??
      modelOptions[0];
    return {
      revision: Math.max(1, Date.parse(entry.updatedAt) || 1),
      sessionRef: normalized,
      bindingId: entry.bindingId,
      bindingKind: entry.bindingKind,
      bindingLocked: bindingLockReason !== null,
      bindingLockReason,
      workspaceRef: entry.workspaceRef,
      workspaceName: entry.workspaceName,
      name: entry.name,
      isArchived: entry.isArchived,
      mode: session?.mode ?? null,
      model: session?.model ?? null,
      reasoningEffort: session?.reasoningEffort ?? null,
      sessionOptions: session?.sessionOptions ?? {},
      sessionOptionDefinitions,
      effectiveModel,
      effectiveReasoningEffort,
      modelSource,
      status:
        entry.status === "error" ? "error" : runtimeOperational ? sessionStatus(runtimeStatus, activity) : "offline",
      modelAvailable,
      modelOptions,
      runtimeThreadAvailable,
      runtimeThreadUnavailableReason: entry.runtimeThreadUnavailableReason,
      runtimeThreadUnavailableDetail: entry.runtimeThreadUnavailableDetail,
      activeTurnId: (await this.options.activeTurnId?.(entry.bindingId, normalized)) ?? null,
      queuedTurns: (await this.options.queuedTurns?.(entry.bindingId, normalized)) ?? [],
      transcriptCompleteness:
        this.options.transcriptProjection.completeness(normalized) ??
        (runtimeThreadAvailable ? "partial" : "live-only"),
      pendingInteractions,
      turnSubmissionCapability: clientTurnSubmissionCapability(
        effectiveModelOption,
        modelAvailable && runtimeOperational && canSubmit,
      ),
      allowedActions:
        runtimeOperational && (!runtimeThreadMissing || recoverableMappedSession)
          ? sessionActions(entry.isArchived, runtimeThreadPresent, activity, lifecycleCapabilities).filter(
              (action) => canSubmit || (action !== "send" && action !== "cancel"),
            )
          : [],
      updatedAt: entry.updatedAt,
    };
  }

  async ensureProjection(sessionRef: string, refreshRuntime = false): Promise<boolean> {
    const normalized = sessionRef.toUpperCase();
    const state = await this.load(refreshRuntime);
    const entry = state.entriesByRef.get(normalized) ?? null;
    if (!entry) return false;
    const runtimeRevision = state.runtimeRevisionByRef.get(normalized);
    const sourceRevision = runtimeRevision ?? entry.updatedAt;
    try {
      const session = await this.options.stateStore.getRuntimeSessionByRef(normalized);
      if (session) {
        if (session.runtimeSessionId && !runtimeRevision) return true;
        await this.options.transcriptProjection.reconcile(session, sourceRevision);
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
          workspaceRef: entry.workspaceRef,
          name: entry.name,
          mode: null,
          model: null,
          reasoningEffort: null,
          hasMessages: true,
          isCurrent: false,
          updatedAt: Date.parse(entry.updatedAt) || Date.now(),
        },
        sourceRevision,
      );
      return true;
    } catch (error) {
      const failure = workBuddyCapabilityFailure(error);
      if (!failure) throw error;
      this.options.transcriptProjection.invalidate(normalized);
      entry.runtimeThreadUnavailableReason = projectionFailureReason(failure);
      entry.runtimeThreadUnavailableDetail = projectionFailureDetail(entry.runtimeThreadUnavailableDetail, failure);
      entry.status =
        entry.runtimeThreadUnavailableReason === "native-state-corrupt" ||
        entry.runtimeThreadUnavailableReason === "runtime-incompatible"
          ? "error"
          : "offline";
      entry.allowedActions = entry.allowedActions.filter(
        (action) => action !== "send" && action !== "cancel" && action !== "adopt",
      );
      return true;
    }
  }

  async runtimeThreadId(sessionRef: string): Promise<string | null> {
    const normalized = sessionRef.toUpperCase();
    const session = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    if (session?.runtimeSessionId) return session.runtimeSessionId;
    return (await this.options.stateStore.getSessionRefTarget(normalized))?.runtimeSessionId ?? null;
  }

  async adopt(sessionRef: string): Promise<RuntimeSessionRecord | null> {
    const normalized = sessionRef.toUpperCase();
    const state = await this.load();
    const entry = state.entriesByRef.get(normalized) ?? null;
    if (!entry || entry.isArchived) return null;
    const workspace = await this.workspaces.require(entry.bindingId, entry.workspaceRef);
    const existing = await this.options.stateStore.getRuntimeSessionByRef(normalized);
    if (existing) {
      if (!existing.workspaceRef) {
        await this.sessionContinuity.forSession(existing.sessionRef).associateWorkspaceRef(workspace.workspaceRef);
        this.invalidate();
        return await this.options.stateStore.getRuntimeSessionByRef(normalized);
      }
      return existing;
    }
    const target = await this.options.stateStore.getSessionRefTarget(normalized);
    if (!target?.runtimeSessionId || !entry) return null;
    await this.options.runtimeAdapters.verifyThreadReady(
      getAgentBinding(this.options.config, target.agentId),
      target.runtimeSessionId,
    );
    await this.sessionContinuity.inConversation({ chatId: target.chatId, bindingId: target.agentId }).adopt({
      sessionRef: normalized,
      sessionId: randomUUID(),
      selection: {
        workspaceRef: workspace.workspaceRef,
        name: entry.name,
        mode: null,
        model: null,
        reasoningEffort: null,
      },
    });
    this.invalidate();
    return await this.options.stateStore.getRuntimeSessionByRef(normalized);
  }

  async ensureWorkspace(bindingId: string, workspaceRef: string): Promise<WorkspaceRecord | null> {
    return await this.workspaces.get(bindingId, workspaceRef);
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
    const previousState = this.state;
    if (!force && this.state && this.state.expiresAt > Date.now()) return this.state;
    const sessions = await this.options.stateStore.listAllRuntimeSessions();
    const bindings: SessionCatalogBindingView[] = [];
    const entriesByRef = new Map<string, SessionCatalogEntryView>();
    const workingDirectoryByRef = new Map<string, string>();
    const runtimeRevisionByRef = new Map<string, string>();

    for (const [bindingId, binding] of Object.entries(this.options.config.agents)) {
      const status = await this.options.stateStore.getRuntimeStatus(bindingId);
      const runtimeUnavailable =
        status?.runtimeAvailability === "startup-unavailable" || !this.options.runtimeAdapters.hasProvider(binding);
      const family = runtimeUnavailable
        ? ((await this.options.runtimeFamily?.(binding)) ?? "unavailable")
        : this.options.runtimeAdapters.familyFor(binding);
      const advertisedLifecycleCapabilities = runtimeUnavailable
        ? { archive: false, restore: false, delete: false }
        : this.options.runtimeAdapters.lifecycleCapabilities(binding);
      const managed = sessions.filter((session) => session.agentId === bindingId);
      const managedRuntimeIds = new Set(
        managed.map((session) => session.runtimeSessionId).filter((id): id is string => Boolean(id)),
      );
      const unavailableDiscovery: RuntimeThreadDiscoverySnapshot = {
        status: "unavailable",
        threads: [],
        limitations: ["runtime-unavailable"],
      };
      let activeDiscoveryFailed = false;
      let activeSnapshot = unavailableDiscovery;
      let archivedSnapshot = unavailableDiscovery;
      if (!runtimeUnavailable) {
        try {
          activeSnapshot = await this.options.runtimeAdapters.discoverAllThreads(
            getAgentBinding(this.options.config, bindingId),
          );
        } catch (error) {
          if (family !== "workbuddy" || !workBuddyCapabilityFailure(error)) throw error;
          activeDiscoveryFailed = true;
        }
        try {
          archivedSnapshot = await this.options.runtimeAdapters.discoverArchivedThreads(
            getAgentBinding(this.options.config, bindingId),
          );
        } catch (error) {
          if (family !== "workbuddy" || !workBuddyCapabilityFailure(error)) throw error;
        }
      }
      const bindingUnavailable = runtimeUnavailable || activeDiscoveryFailed;
      const bindingDisconnected = bindingUnavailable || status?.websocketConnected === false;
      const lifecycleCapabilities = bindingDisconnected
        ? { archive: false, restore: false, delete: false }
        : advertisedLifecycleCapabilities;
      const discoveredActive = activeSnapshot.threads.filter((thread) => !thread.parentRuntimeThreadId);
      const discoveredArchived = archivedSnapshot.threads.filter((thread) => !thread.parentRuntimeThreadId);
      let workspaces: WorkspaceRecord[];
      try {
        const snapshot = bindingUnavailable
          ? { status: "unavailable" as const, identities: [] }
          : await this.options.runtimeAdapters.discoverWorkspaces(getAgentBinding(this.options.config, bindingId));
        workspaces = (
          await synchronizeRuntimeWorkspaces({
            bindingId,
            snapshot,
            workspaces: this.workspaces,
          })
        ).workspaces;
      } catch {
        workspaces = await this.workspaces.list(bindingId);
      }
      const defaultWorkspace = await this.workspaces.ensureDefault(bindingId);
      const workspaceByRef = new Map(workspaces.map((workspace) => [workspace.workspaceRef, workspace]));
      workspaceByRef.set(defaultWorkspace.workspaceRef, defaultWorkspace);
      const discovered = [
        ...new Map(
          [...discoveredActive, ...discoveredArchived].map((thread) => [thread.runtimeThreadId, thread]),
        ).values(),
      ];
      const discoveredById = new Map(discovered.map((thread) => [thread.runtimeThreadId, thread]));
      const entries: SessionCatalogEntryView[] = await Promise.all(
        managed.map(async (session) => {
          const workspace = workspaceByRef.get(session.workspaceRef ?? "") ?? defaultWorkspace;
          if (!session.workspaceRef) {
            await this.options.stateStore.setRuntimeSessionWorkspace(
              session.chatId,
              session.agentId,
              session.sessionId,
              workspace.workspaceRef,
            );
            session.workspaceRef = workspace.workspaceRef;
          }
          const runtimeSessionId = session.runtimeSessionId;
          const discoveredRuntimeThread = runtimeSessionId ? discoveredById.get(runtimeSessionId) : undefined;
          const runtimeThread =
            discoveredRuntimeThread ??
            (family === "workbuddy" && runtimeSessionId && isCodeBuddySessionRuntimeTarget(runtimeSessionId)
              ? {
                  runtimeThreadId: runtimeSessionId,
                  name: session.name,
                  updatedAt: session.updatedAt,
                  workingDirectory: workspace.rootPath,
                  workspaceKind: "persistent" as const,
                  adoption: { status: "available" as const },
                }
              : undefined);
          if (runtimeThread) {
            runtimeRevisionByRef.set(
              session.sessionRef.toUpperCase(),
              `${runtimeThread.runtimeThreadId}:${runtimeThread.updatedAt}`,
            );
          }
          const workingDirectory = runtimeThread?.workingDirectory ?? workspace.rootPath;
          workingDirectoryByRef.set(session.sessionRef.toUpperCase(), workingDirectory);
          const activity = (await this.options.sessionActivity?.(bindingId, session.sessionRef)) ?? "idle";
          return managedEntry(session, family, workspace, status, activity, lifecycleCapabilities, runtimeThread);
        }),
      );
      for (const thread of discovered) {
        if (managedRuntimeIds.has(thread.runtimeThreadId)) continue;
        const identity = thread.workspaceIdentity ?? {
          key: thread.workingDirectory ? resolve(thread.workingDirectory) : `thread:${thread.runtimeThreadId}`,
          kind: thread.workspaceKind ?? ("persistent" as const),
          localRoot: thread.workingDirectory ?? null,
        };
        const workspace =
          identity.kind === "transient"
            ? defaultWorkspace
            : (workspaces.find((candidate) => candidate.runtimeIdentityKey === identity.key) ??
              (identity.localRoot
                ? workspaces.find((candidate) => resolve(candidate.rootPath) === resolve(identity.localRoot as string))
                : null) ??
              defaultWorkspace);
        const sessionRef = await this.options.stateStore.getOrCreateSessionRef({
          chatId: CLIENT_CATALOG_CHAT,
          agentId: bindingId,
          runtimeSessionId: thread.runtimeThreadId,
        });
        runtimeRevisionByRef.set(sessionRef.toUpperCase(), `${thread.runtimeThreadId}:${thread.updatedAt}`);
        workingDirectoryByRef.set(sessionRef.toUpperCase(), thread.workingDirectory ?? workspace.rootPath);
        const unavailable =
          thread.adoption.status === "unavailable"
            ? { reason: thread.adoption.reason, detail: thread.adoption.detail ?? null }
            : null;
        entries.push({
          sessionRef,
          entryKind: "runtime-thread",
          bindingId,
          bindingKind: family,
          workspaceRef: workspace.workspaceRef,
          workspaceName: workspace.name,
          name: thread.name || `Session ${sessionRef}`,
          isArchived: thread.isArchived === true,
          status: sessionStatus(status, "idle"),
          updatedAt: new Date(thread.updatedAt || Date.now()).toISOString(),
          isCurrent: false,
          isAdopted: false,
          unreadCount: 0,
          pendingInteractionCount: 0,
          allowedActions: catalogActions(thread.isArchived === true, false, true, "idle", lifecycleCapabilities).filter(
            (action) => action !== "adopt" || unavailable === null,
          ),
          runtimeThreadUnavailableReason: unavailable?.reason ?? null,
          runtimeThreadUnavailableDetail: unavailable?.detail ?? null,
        });
      }
      if (activeSnapshot.status !== "complete" || archivedSnapshot.status !== "complete") {
        const previousBinding = previousState?.view.bindings.find((candidate) => candidate.bindingId === bindingId);
        const knownRefs = new Set(entries.map((entry) => entry.sessionRef.toUpperCase()));
        for (const previous of previousBinding?.entries ?? []) {
          const normalizedRef = previous.sessionRef.toUpperCase();
          if (knownRefs.has(normalizedRef) || previous.entryKind !== "runtime-thread") continue;
          entries.push({ ...previous, status: "offline", allowedActions: ["open"] });
          const previousRevision = previousState?.runtimeRevisionByRef.get(normalizedRef);
          if (previousRevision) runtimeRevisionByRef.set(normalizedRef, previousRevision);
          const previousWorkingDirectory = previousState?.workingDirectoryByRef.get(normalizedRef);
          if (previousWorkingDirectory) workingDirectoryByRef.set(normalizedRef, previousWorkingDirectory);
        }
      }
      await Promise.all(
        entries.map(async (entry) => {
          entry.pendingInteractionCount = (
            await this.options.stateStore.listPendingRuntimeInteractions(entry.sessionRef)
          ).length;
          if (bindingDisconnected) {
            entry.status = "offline";
            entry.allowedActions = ["open"];
          }
        }),
      );
      entries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      for (const entry of entries) entriesByRef.set(entry.sessionRef.toUpperCase(), entry);
      bindings.push({
        bindingId,
        displayName: binding.displayName || bindingId,
        kind: family,
        status: bindingDisconnected ? "disconnected" : status?.websocketConnected === true ? "connected" : "unknown",
        entries,
      });
    }
    this.state = {
      view: { revision: Date.now(), bindings },
      entriesByRef,
      workingDirectoryByRef,
      runtimeRevisionByRef,
      expiresAt: Date.now() + 2_000,
    };
    this.rememberRuntimeWorkspaceLocations(this.state);
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
  const allowedKinds = native ? [...native.attachments.allowedKinds] : modalityKinds;
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
  workspace: WorkspaceRecord,
  status: RuntimeStatus | null,
  activity: SessionActivity,
  lifecycleCapabilities: RuntimeLifecycleCapabilities,
  runtimeThread?: RuntimeThreadCandidate,
): SessionCatalogEntryView {
  const unavailable =
    runtimeThread?.adoption.status === "unavailable"
      ? { reason: runtimeThread.adoption.reason, detail: runtimeThread.adoption.detail ?? null }
      : null;
  const canRecoverMissing = Boolean(session.runtimeSessionId && lifecycleCapabilities.recoverMissing);
  const allowedActions =
    session.runtimeSessionId && !runtimeThread && !canRecoverMissing
      ? (["open"] as SessionCatalogAction[])
      : catalogActions(
          runtimeThread?.isArchived === true,
          true,
          Boolean(runtimeThread),
          activity,
          lifecycleCapabilities,
        ).filter((action) => unavailable === null || (action !== "send" && action !== "cancel"));
  return {
    sessionRef: session.sessionRef,
    entryKind: "session",
    bindingId: session.agentId,
    bindingKind,
    workspaceRef: workspace.workspaceRef,
    workspaceName: workspace.name,
    name: session.name || runtimeThread?.name || `Session ${session.sessionRef}`,
    isArchived: runtimeThread?.isArchived === true,
    status: sessionStatus(status, activity),
    updatedAt: new Date(Math.max(session.updatedAt, runtimeThread?.updatedAt ?? 0)).toISOString(),
    isCurrent: session.isCurrent,
    isAdopted: true,
    unreadCount: 0,
    pendingInteractionCount: 0,
    allowedActions,
    runtimeThreadUnavailableReason: unavailable?.reason ?? null,
    runtimeThreadUnavailableDetail: unavailable?.detail ?? null,
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

function projectionFailureDetail(existing: string | null, error: WorkBuddyCapabilityFailure): string {
  const availability = workBuddyCapabilityAvailability(error.code);
  if (availability === "unavailable") {
    const detail = existing ?? error.message;
    return boundedProjectionFailureDetail(
      /\bretry\b/iu.test(detail) ? detail : `${detail} Retry this exact WorkBuddy Task when its endpoint is available.`,
    );
  }
  if (availability === "unsupported") {
    return boundedProjectionFailureDetail(
      `${error.message} This WorkBuddy Runtime Capability is unsupported; stored Transcript data remains readable.`,
    );
  }
  const conflictDetail =
    existing && !/\bretry\b/iu.test(existing) && /(?:identity|replay|different\s+task)/iu.test(existing)
      ? existing
      : `${error.message} Stored Transcript data remains readable, but adoption and send stay blocked.`;
  return boundedProjectionFailureDetail(conflictDetail);
}

function projectionFailureReason(error: WorkBuddyCapabilityFailure): RuntimeThreadUnavailableReasonView {
  const availability = workBuddyCapabilityAvailability(error.code);
  if (availability === "unsupported") return "runtime-incompatible";
  if (availability === "unavailable") return "external-ownership-unverifiable";
  if (
    error.code === "task-identity-mismatch" ||
    error.code === "task-replay-incomplete" ||
    error.code === "workspace-identity-mismatch" ||
    error.code === "task-not-found"
  ) {
    return "native-state-corrupt";
  }
  return "external-ownership-unverifiable";
}

function boundedProjectionFailureDetail(detail: string): string {
  const suffix = "…[TRUNCATED]";
  return detail.length <= 512 ? detail : `${detail.slice(0, 512 - suffix.length)}${suffix}`;
}

function sessionStatus(status: RuntimeStatus | null, activity: SessionActivity): SessionCatalogEntryView["status"] {
  if (activity !== "idle") return activity;
  return status?.runtimeAvailability === "startup-unavailable" || status?.websocketConnected === false
    ? "offline"
    : "idle";
}
