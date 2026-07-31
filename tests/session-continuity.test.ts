import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionContinuity } from "../src/session-continuity";
import { createStateStore } from "../src/state";

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
    projectId: null,
    name: "Planned",
    mode: "read-only",
    model: "gpt-planned",
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
    projectId: null,
    name: "Planned",
    mode: "read-only",
    model: "gpt-planned",
    reasoningEffort: "high",
    sessionOptions: { agent: "build", variant: "high" },
    runtimeThreadId: null,
    turnOrigin: "clawchat",
  });

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
    projectId: null,
    name: "Client work",
    mode: "workspace-write",
    model: "gpt-client",
    reasoningEffort: "medium",
  });

  expect(created).toMatchObject({
    bindingId: "codex",
    sessionId: "session-client",
    projectId: null,
    name: "Client work",
    mode: "workspace-write",
    model: "gpt-client",
    reasoningEffort: "medium",
    runtimeThreadId: null,
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
    projectId: null,
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
    projectId: null,
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

it("maps one Runtime Workspace Identity unambiguously while allowing cross-Binding Project reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-session-continuity-workspace-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  const firstProject = await stateStore.insertProject({
    projectId: "project-shared",
    name: "Shared",
    rootPath: join(directory, "shared"),
  });
  await stateStore.insertProject({
    projectId: "project-other",
    name: "Other",
    rootPath: join(directory, "other"),
  });
  const continuity = createSessionContinuity({ stateStore });

  await continuity.associateWorkspace({
    bindingId: "codex-a",
    runtimeKind: "codex",
    identityKey: "native-workspace",
    projectId: firstProject.projectId,
  });
  await continuity.associateWorkspace({
    bindingId: "codex-b",
    runtimeKind: "codex",
    identityKey: "native-workspace",
    projectId: firstProject.projectId,
  });

  await expect(
    continuity.associateWorkspace({
      bindingId: "codex-a",
      runtimeKind: "codex",
      identityKey: "native-workspace",
      projectId: "project-other",
    }),
  ).rejects.toThrow("already mapped");
  expect(await stateStore.getRuntimeWorkspaceMapping("codex-b", "codex", "native-workspace")).toMatchObject({
    projectId: "project-shared",
  });

  await stateStore.close();
});
