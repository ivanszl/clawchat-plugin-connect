import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore } from "../src/persistence/state";
import { createSessionContinuity } from "../src/workspaces/session-continuity";

it("materializes one Turn Target when concurrent first messages consume a Session Intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-session-continuity-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  const sessionIds = ["session-first", "session-second"];
  const continuity = createSessionContinuity({
    stateStore,
    sessionIdFactory: () => sessionIds.shift() ?? "session-extra",
  });
  const conversation = continuity.inConversation({ chatId: "chat-race", bindingId: "codex" });

  await conversation.planNext({
    workspaceRef: "WSDEFALT",
    name: "Planned",
    mode: "read-only",
    model: { model: "gpt-planned" },
    reasoningEffort: "high",
    sessionOptions: { agent: "build", variant: "high" },
  });

  const [first, second] = await Promise.all([
    conversation.targetForOrdinaryTurn("clawchat"),
    conversation.targetForOrdinaryTurn("clawchat"),
  ]);

  expect(first.sessionRef).toBe(second.sessionRef);
  expect(first.sessionId).toBe(second.sessionId);
  expect(first).toMatchObject({
    bindingId: "codex",
    chatId: "chat-race",
    workspaceRef: "WSDEFALT",
    name: "Planned",
    mode: "read-only",
    model: { model: "gpt-planned" },
    reasoningEffort: "high",
    sessionOptions: { agent: "build", variant: "high" },
    runtimeThreadId: null,
    turnOrigin: "clawchat",
  });
  await expect(stateStore.getRuntimeSessionByRef(first.sessionRef)).resolves.toMatchObject({ hasMessages: false });
  await expect(stateStore.sessionBindingLock(first.sessionRef)).resolves.toBeNull();

  await stateStore.close();
});

it("creates an explicit empty Session from one complete selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-session-continuity-create-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  const continuity = createSessionContinuity({
    stateStore,
    sessionIdFactory: () => "session-client",
  });
  const conversation = continuity.inConversation({
    chatId: "__connect_client_session__:client-created",
    bindingId: "codex",
  });

  const created = await conversation.create({
    workspaceRef: "WSDEFALT",
    name: "Client work",
    mode: "workspace-write",
    model: { model: "gpt-client" },
    reasoningEffort: "medium",
  });

  expect(created).toMatchObject({
    bindingId: "codex",
    sessionId: "session-client",
    workspaceRef: "WSDEFALT",
    name: "Client work",
    mode: "workspace-write",
    model: { model: "gpt-client" },
    reasoningEffort: "medium",
    runtimeThreadId: null,
  });

  await stateStore.close();
  const reopened = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await expect(reopened.getRuntimeSessionByRef(created.sessionRef)).resolves.toMatchObject({
    agentId: "codex",
    sessionId: "session-client",
    hasMessages: false,
  });
  await expect(reopened.sessionBindingLock(created.sessionRef)).resolves.toBeNull();
  await expect(reopened.getSessionRefTarget(created.sessionRef)).resolves.toMatchObject({
    sessionRef: created.sessionRef,
    agentId: "codex",
    sessionId: "session-client",
  });
  await reopened.close();
});

it("changes an empty Session Binding and fixes the accepted Turn Target atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-session-continuity-binding-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  const continuity = createSessionContinuity({
    stateStore,
    sessionIdFactory: () => "session-binding",
  });
  const created = await continuity
    .inConversation({ chatId: "__connect_client_session__:binding", bindingId: "codex" })
    .create({ workspaceRef: "WSDEFALT", name: "Empty", mode: null, model: null, reasoningEffort: null });

  expect(await continuity.forSession(created.sessionRef).bindingLock()).toBeNull();
  await continuity.forSession(created.sessionRef).changeBinding("opencode");
  expect(await stateStore.getRuntimeSessionByRef(created.sessionRef)).toMatchObject({
    agentId: "opencode",
    hasMessages: false,
    runtimeSessionId: null,
  });

  expect(await stateStore.acceptSessionTurn({ sessionRef: created.sessionRef, bindingId: "opencode" })).toBe(true);
  await expect(continuity.forSession(created.sessionRef).changeBinding("codex")).rejects.toMatchObject({
    code: "session-binding-locked",
  });
  expect(await stateStore.getRuntimeSessionByRef(created.sessionRef)).toMatchObject({
    agentId: "opencode",
    hasMessages: true,
  });
  await stateStore.close();
});

it("continues a Workspace in a fresh Session without moving Runtime identity or history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-session-continuity-continue-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.insertWorkspace({
    bindingId: "codex",
    workspaceRef: "SHARED01",
    runtimeIdentityKey: null,
    source: "runtime",
    name: "Shared",
    rootPath: join(directory, "shared"),
    selectable: true,
  });
  await stateStore.insertWorkspace({
    bindingId: "opencode",
    workspaceRef: "SHARED02",
    runtimeIdentityKey: null,
    source: "runtime",
    name: "Shared",
    rootPath: join(directory, "shared"),
    selectable: true,
  });
  await stateStore.upsertRuntimeSession({
    chatId: "source-chat",
    sessionId: "source-session",
    agentId: "codex",
    runtimeSessionId: "source-thread",
    workspaceRef: "SHARED01",
    name: "Source",
    hasMessages: true,
  });
  const source = await stateStore.getCurrentRuntimeSession("source-chat", "codex");
  const continuity = createSessionContinuity({
    stateStore,
    sessionIdFactory: () => "continuation-session",
    conversationIdFactory: () => "__connect_client_session__:continuation",
    resolveContinuationWorkspace: async () => "SHARED02",
  });

  const continuation = await continuity.forSession(source?.sessionRef ?? "").continueWith("opencode");

  expect(continuation).toMatchObject({
    bindingId: "opencode",
    workspaceRef: "SHARED02",
    sessionId: "continuation-session",
    runtimeThreadId: null,
    sessionOptions: {},
  });
  expect(continuation.sessionRef).not.toBe(source?.sessionRef);
  expect(await stateStore.getRuntimeSessionByRef(continuation.sessionRef)).toMatchObject({
    hasMessages: false,
    runtimeSessionId: null,
  });
  expect(await stateStore.getRuntimeSessionByRef(source?.sessionRef ?? "")).toMatchObject({
    agentId: "codex",
    runtimeSessionId: "source-thread",
    hasMessages: true,
  });
  await stateStore.close();
});

it("journals native lifecycle work and reconciles an interrupted local commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-session-continuity-lifecycle-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.upsertRuntimeSession({
    chatId: "chat-lifecycle",
    sessionId: "session-lifecycle",
    agentId: "codex",
    runtimeSessionId: "thread-lifecycle",
    workspaceRef: "WSDEFALT",
    name: "Lifecycle",
    isCurrent: true,
  });
  const session = await stateStore.getCurrentRuntimeSession("chat-lifecycle", "codex");
  expect(session).not.toBeNull();
  const nativeCalls: string[] = [];
  let failLocalCommit = true;
  const continuity = createSessionContinuity({
    stateStore,
    lifecycle: {
      capabilities: () => ({ archive: true, restore: true, delete: true }),
      archive: async (_bindingId, runtimeThreadId) => {
        nativeCalls.push(`archive:${runtimeThreadId}`);
      },
      restore: async () => {},
      delete: async () => {},
    },
    beforeLifecycleLocalCommit: async () => {
      if (failLocalCommit) throw new Error("simulated process interruption");
    },
  });

  await expect(continuity.forSession(session?.sessionRef ?? "").archive()).rejects.toThrow(
    "simulated process interruption",
  );
  expect(nativeCalls).toEqual(["archive:thread-lifecycle"]);
  expect(await stateStore.getCurrentRuntimeSession("chat-lifecycle", "codex")).not.toBeNull();

  failLocalCommit = false;
  await continuity.reconcileLifecycle();

  expect(nativeCalls).toEqual(["archive:thread-lifecycle"]);
  expect(await stateStore.getCurrentRuntimeSession("chat-lifecycle", "codex")).toBeNull();
  expect(await stateStore.getSessionIntent("chat-lifecycle", "codex")).toMatchObject({
    name: "Lifecycle",
  });
  expect(await stateStore.listIncompleteSessionLifecycleOperations()).toEqual([]);

  await stateStore.close();
});

it("keeps runtime lifecycle coordination claimed through native and local deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-session-continuity-coordination-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.upsertRuntimeSession({
    chatId: "chat-delete",
    sessionId: "session-delete",
    agentId: "codex",
    runtimeSessionId: "thread-delete",
    workspaceRef: "WSDEFALT",
    name: "Delete",
    isCurrent: true,
  });
  const session = await stateStore.getCurrentRuntimeSession("chat-delete", "codex");
  const order: string[] = [];
  const continuity = createSessionContinuity({
    stateStore,
    claimRuntimeLifecycle: async (sessionRef) => {
      order.push(`claim:${sessionRef}`);
      return async () => {
        order.push(`release:${sessionRef}`);
      };
    },
    lifecycle: {
      capabilities: () => ({ archive: true, restore: true, delete: true }),
      archive: async () => {},
      restore: async () => {},
      delete: async () => {
        order.push("native-delete");
        expect(await stateStore.getRuntimeSessionByRef(session?.sessionRef ?? "")).not.toBeNull();
      },
    },
    beforeLifecycleLocalCommit: async () => {
      order.push("local-commit");
    },
  });

  await continuity.forSession(session?.sessionRef ?? "").delete();

  expect(order).toEqual([
    `claim:${session?.sessionRef}`,
    "native-delete",
    "local-commit",
    `release:${session?.sessionRef}`,
  ]);
  expect(await stateStore.getRuntimeSessionByRef(session?.sessionRef ?? "")).toBeNull();
  await stateStore.close();
});
