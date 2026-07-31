import { randomUUID } from "node:crypto";
import { type RuntimeLifecycleCapabilities, RuntimeLifecycleError } from "./runtime/types";
import type { ConnectStateStore, SessionLifecycleAction, SessionLifecycleOperationRecord } from "./state";
import type { RuntimeSessionRecord } from "./types";

export type TurnOrigin = "client" | "clawchat";

export interface SessionScope {
  chatId: string;
  bindingId: string;
}

export interface SessionSelection {
  projectId: string | null;
  name: string | null;
  mode: string | null;
  model: string | null;
  reasoningEffort: string | null;
  sessionOptions?: Record<string, string>;
}

export interface SessionTarget extends SessionSelection {
  chatId: string;
  bindingId: string;
  sessionId: string;
  sessionRef: string;
  runtimeThreadId: string | null;
}

export interface TurnTarget extends SessionTarget {
  turnOrigin: TurnOrigin;
}

export interface ConversationSessions {
  planNext(selection: SessionSelection): Promise<void>;
  create(selection: SessionSelection): Promise<SessionTarget>;
  targetForOrdinaryTurn(turnOrigin: TurnOrigin): Promise<TurnTarget>;
  switchTo(sessionId: string): Promise<boolean>;
  adopt(input: { sessionRef: string; sessionId: string; selection: SessionSelection }): Promise<SessionTarget | null>;
  changeMode(mode: string | null): Promise<"intent" | "session">;
  changeModel(model: string | null, reasoningEffort: string | null): Promise<"intent" | "session">;
  changeSessionOptions(sessionOptions: Record<string, string>): Promise<"intent" | "session">;
}

export interface SessionContinuity {
  inConversation(scope: SessionScope): ConversationSessions;
  forSession(sessionRef: string): SessionLifecycle;
  associateWorkspace(input: {
    bindingId: string;
    runtimeKind: string;
    identityKey: string;
    projectId: string;
  }): Promise<void>;
  reconcileLifecycle(): Promise<void>;
}

export interface RuntimeLifecycle {
  capabilities(bindingId: string): RuntimeLifecycleCapabilities;
  archive(bindingId: string, runtimeThreadId: string): Promise<void>;
  restore(bindingId: string, runtimeThreadId: string): Promise<void>;
  delete(bindingId: string, runtimeThreadId: string): Promise<void>;
}

export interface SessionLifecycle {
  capabilities(): Promise<RuntimeLifecycleCapabilities>;
  targetForTurn(turnOrigin: TurnOrigin): Promise<TurnTarget>;
  attachRuntimeThread(runtimeThreadId: string | null): Promise<void>;
  changeModel(model: string | null, reasoningEffort: string | null): Promise<void>;
  changeSessionOptions(sessionOptions: Record<string, string>): Promise<void>;
  associateProject(projectId: string): Promise<void>;
  discardEmpty(): Promise<void>;
  archive(): Promise<void>;
  restore(): Promise<void>;
  delete(): Promise<void>;
}

export class SessionLifecycleError extends Error {
  constructor(
    readonly code: "session-not-found" | "session-state-conflict" | "session-action-unsupported",
    message: string,
  ) {
    super(message);
  }
}

export interface SessionContinuityOptions {
  stateStore: ConnectStateStore;
  sessionIdFactory?: () => string;
  operationIdFactory?: () => string;
  lifecycle?: RuntimeLifecycle;
  releaseRuntimeHandle?: (sessionRef: string) => Promise<void>;
  claimRuntimeLifecycle?: (sessionRef: string) => Promise<() => Promise<void>>;
  beforeLifecycleLocalCommit?: (operation: SessionLifecycleOperationRecord) => Promise<void>;
}

export function createSessionContinuity(options: SessionContinuityOptions): SessionContinuity {
  const sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  const operationIdFactory = options.operationIdFactory ?? randomUUID;
  const runLifecycle = async (sessionRef: string, action: SessionLifecycleAction): Promise<void> => {
    const release = options.claimRuntimeLifecycle
      ? await options.claimRuntimeLifecycle(sessionRef.toUpperCase())
      : async () => undefined;
    const execute = async () => {
      const lifecycle = requireLifecycle(options.lifecycle);
      const session = await options.stateStore.getRuntimeSessionByRef(sessionRef);
      const target = session ? null : await options.stateStore.getSessionRefTarget(sessionRef);
      const bindingId = session?.agentId ?? target?.agentId;
      const runtimeThreadId = session?.runtimeSessionId ?? target?.runtimeSessionId;
      if (!bindingId) throw new SessionLifecycleError("session-not-found", `Session ${sessionRef} was not found`);
      if (!runtimeThreadId) {
        throw new SessionLifecycleError("session-state-conflict", `Session ${sessionRef} has no Runtime Thread`);
      }
      requireLifecycleCapability(lifecycle.capabilities(bindingId), action);
      await options.releaseRuntimeHandle?.(sessionRef.toUpperCase());
      const operation = await options.stateStore.createSessionLifecycleOperation({
        operationId: operationIdFactory(),
        sessionRef,
        action,
        bindingId,
        runtimeThreadId,
      });
      await executeLifecycleOperation(options, lifecycle, operation, session);
    };
    try {
      await execute();
    } finally {
      await release();
    }
  };
  return {
    inConversation(scope) {
      return {
        async planNext(selection) {
          await options.stateStore.setSessionIntent({
            chatId: scope.chatId,
            agentId: scope.bindingId,
            ...selection,
          });
        },
        async create(selection) {
          await options.stateStore.setSessionIntent({
            chatId: scope.chatId,
            agentId: scope.bindingId,
            ...selection,
          });
          const session = await options.stateStore.resolveOrMaterializeRuntimeSession({
            chatId: scope.chatId,
            agentId: scope.bindingId,
            sessionId: sessionIdFactory(),
          });
          return sessionTarget(session);
        },
        async targetForOrdinaryTurn(turnOrigin) {
          const session = await options.stateStore.resolveOrMaterializeRuntimeSession({
            chatId: scope.chatId,
            agentId: scope.bindingId,
            sessionId: sessionIdFactory(),
          });
          return {
            ...sessionTarget(session),
            turnOrigin,
          };
        },
        async switchTo(sessionId) {
          return await options.stateStore.switchRuntimeSession(scope.chatId, scope.bindingId, sessionId);
        },
        async adopt(input) {
          const session = await options.stateStore.adoptRuntimeThreadRef({
            sessionRef: input.sessionRef,
            chatId: scope.chatId,
            sessionId: input.sessionId,
            agentId: scope.bindingId,
            projectId: input.selection.projectId,
            name: input.selection.name,
            mode: input.selection.mode,
            model: input.selection.model,
            reasoningEffort: input.selection.reasoningEffort,
            sessionOptions: input.selection.sessionOptions,
          });
          return session ? sessionTarget(session) : null;
        },
        async changeMode(mode) {
          const intent = await options.stateStore.getSessionIntent(scope.chatId, scope.bindingId);
          const current = await options.stateStore.getCurrentRuntimeSession(scope.chatId, scope.bindingId);
          if (intent || !current) {
            await this.planNext({
              projectId: intent?.projectId ?? null,
              name: intent?.name ?? null,
              mode,
              model: intent?.model ?? null,
              reasoningEffort: intent?.reasoningEffort ?? null,
              sessionOptions: intent?.sessionOptions,
            });
            return "intent";
          }
          await options.stateStore.upsertRuntimeSession({
            ...current,
            mode,
            runtimeSessionId: current.runtimeSessionId,
          });
          return "session";
        },
        async changeModel(model, reasoningEffort) {
          const intent = await options.stateStore.getSessionIntent(scope.chatId, scope.bindingId);
          const current = await options.stateStore.getCurrentRuntimeSession(scope.chatId, scope.bindingId);
          if (intent || !current) {
            await this.planNext({
              projectId: intent?.projectId ?? null,
              name: intent?.name ?? null,
              mode: intent?.mode ?? null,
              model,
              reasoningEffort,
              sessionOptions: intent?.sessionOptions,
            });
            return "intent";
          }
          const updated = await options.stateStore.setRuntimeSessionModelSelection(
            current.chatId,
            current.agentId,
            current.sessionId,
            model,
            reasoningEffort,
          );
          if (!updated) throw new Error(`Session ${current.sessionRef} no longer exists`);
          return "session";
        },
        async changeSessionOptions(sessionOptions) {
          const intent = await options.stateStore.getSessionIntent(scope.chatId, scope.bindingId);
          const current = await options.stateStore.getCurrentRuntimeSession(scope.chatId, scope.bindingId);
          if (intent || !current) {
            await this.planNext({
              projectId: intent?.projectId ?? null,
              name: intent?.name ?? null,
              mode: intent?.mode ?? null,
              model: intent?.model ?? null,
              reasoningEffort: intent?.reasoningEffort ?? null,
              sessionOptions,
            });
            return "intent";
          }
          const updated = await options.stateStore.setRuntimeSessionOptions(
            current.chatId,
            current.agentId,
            current.sessionId,
            sessionOptions,
          );
          if (!updated) throw new Error(`Session ${current.sessionRef} no longer exists`);
          return "session";
        },
      };
    },
    forSession(sessionRef) {
      const normalized = sessionRef.trim().toUpperCase();
      return {
        async capabilities() {
          const lifecycle = requireLifecycle(options.lifecycle);
          const session = await options.stateStore.getRuntimeSessionByRef(normalized);
          const target = session ? null : await options.stateStore.getSessionRefTarget(normalized);
          const bindingId = session?.agentId ?? target?.agentId;
          if (!bindingId) throw new Error(`Session ${normalized} was not found`);
          return lifecycle.capabilities(bindingId);
        },
        async targetForTurn(turnOrigin) {
          const session = await options.stateStore.getRuntimeSessionByRef(normalized);
          if (!session) throw new Error(`Session ${normalized} was not found`);
          return { ...sessionTarget(session), turnOrigin };
        },
        async attachRuntimeThread(runtimeThreadId) {
          const session = await options.stateStore.getRuntimeSessionByRef(normalized);
          if (!session) throw new Error(`Session ${normalized} was not found`);
          await options.stateStore.setRuntimeSessionId(
            session.chatId,
            session.agentId,
            session.sessionId,
            runtimeThreadId,
          );
        },
        async changeModel(model, reasoningEffort) {
          const session = await options.stateStore.getRuntimeSessionByRef(normalized);
          if (!session) throw new Error(`Session ${normalized} was not found`);
          const updated = await options.stateStore.setRuntimeSessionModelSelection(
            session.chatId,
            session.agentId,
            session.sessionId,
            model,
            reasoningEffort,
          );
          if (!updated) throw new Error(`Session ${normalized} was not found`);
        },
        async changeSessionOptions(sessionOptions) {
          const session = await options.stateStore.getRuntimeSessionByRef(normalized);
          if (!session) throw new Error(`Session ${normalized} was not found`);
          const updated = await options.stateStore.setRuntimeSessionOptions(
            session.chatId,
            session.agentId,
            session.sessionId,
            sessionOptions,
          );
          if (!updated) throw new Error(`Session ${normalized} was not found`);
        },
        async associateProject(projectId) {
          const session = await options.stateStore.getRuntimeSessionByRef(normalized);
          if (!session) throw new Error(`Session ${normalized} was not found`);
          const updated = await options.stateStore.setRuntimeSessionProject(
            session.chatId,
            session.agentId,
            session.sessionId,
            projectId,
          );
          if (!updated) throw new Error(`Session ${normalized} was not found`);
        },
        async discardEmpty() {
          const session = await options.stateStore.getRuntimeSessionByRef(normalized);
          if (!session) return;
          if (session.runtimeSessionId) throw new Error(`Session ${normalized} has a Runtime Thread`);
          await options.stateStore.deleteSessionByRef(normalized);
        },
        async archive() {
          await runLifecycle(normalized, "archive");
        },
        async restore() {
          await runLifecycle(normalized, "restore");
        },
        async delete() {
          await runLifecycle(normalized, "delete");
        },
      };
    },
    async associateWorkspace(input) {
      await options.stateStore.mapRuntimeWorkspaceIdentity(input);
    },
    async reconcileLifecycle() {
      const lifecycle = requireLifecycle(options.lifecycle);
      for (const operation of await options.stateStore.listIncompleteSessionLifecycleOperations()) {
        const session = await options.stateStore.getRuntimeSessionByRef(operation.sessionRef);
        await executeLifecycleOperation(options, lifecycle, operation, session);
      }
    },
  };
}

function sessionTarget(session: RuntimeSessionRecord): SessionTarget {
  return {
    chatId: session.chatId,
    bindingId: session.agentId,
    sessionId: session.sessionId,
    sessionRef: session.sessionRef,
    runtimeThreadId: session.runtimeSessionId,
    projectId: session.projectId,
    name: session.name,
    mode: session.mode,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    sessionOptions: session.sessionOptions,
  };
}

async function executeLifecycleOperation(
  options: SessionContinuityOptions,
  lifecycle: RuntimeLifecycle,
  operation: SessionLifecycleOperationRecord,
  session: RuntimeSessionRecord | null,
): Promise<void> {
  if (operation.state === "intent") {
    try {
      await lifecycle[operation.action](operation.bindingId, operation.runtimeThreadId);
    } catch (error) {
      if (error instanceof RuntimeLifecycleError) {
        const code =
          error.code === "not-found"
            ? "session-not-found"
            : error.code === "unsupported"
              ? "session-action-unsupported"
              : "session-state-conflict";
        throw new SessionLifecycleError(code, error.message);
      }
      throw error;
    }
    await options.stateStore.setSessionLifecycleOperationState(operation.operationId, "native-confirmed");
  }
  const confirmed = { ...operation, state: "native-confirmed" as const };
  await options.beforeLifecycleLocalCommit?.(confirmed);
  if (operation.action === "archive" && session?.isCurrent) {
    await options.stateStore.setSessionIntent({
      chatId: session.chatId,
      agentId: session.agentId,
      projectId: session.projectId,
      name: session.name,
      mode: session.mode,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      sessionOptions: session.sessionOptions,
    });
  }
  if (operation.action === "delete") await options.stateStore.deleteSessionByRef(operation.sessionRef);
  await options.stateStore.setSessionLifecycleOperationState(operation.operationId, "complete");
}

function requireLifecycle(lifecycle: RuntimeLifecycle | undefined): RuntimeLifecycle {
  if (!lifecycle) throw new Error("Session lifecycle is unavailable");
  return lifecycle;
}

function requireLifecycleCapability(capabilities: RuntimeLifecycleCapabilities, action: SessionLifecycleAction): void {
  if (!capabilities[action]) {
    throw new SessionLifecycleError("session-action-unsupported", `Runtime Adapter does not support Session ${action}`);
  }
}
