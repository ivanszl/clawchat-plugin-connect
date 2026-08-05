import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
import { createOpenCodeRuntimeAdapter } from "../src/runtime/opencode-adapter";
import type { OpenCodeMessage, OpenCodeServerClient } from "../src/runtime/opencode-server";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { releasedRuntimeAdapters } from "../src/runtime/released-adapters";
import {
  type ConnectRuntimeAdapter,
  RuntimeLifecycleError,
  runtimeActivityOrdinal,
  runtimeInputIdentity,
} from "../src/runtime/types";
import { createWorkBuddyRuntimeAdapter, type WorkBuddyRuntimeSource } from "../src/runtime/workbuddy-adapter";
import type { AgentBindingConfig } from "../src/types";
import { fixedRuntimeAdapter } from "./runtime-adapter-fixture";

interface AdapterHarness {
  adapter: ConnectRuntimeAdapter;
  binding: AgentBindingConfig;
  activateThread(): void;
  closeCount(): number;
  failNextArchive(): void;
  lifecycleCalls(): string[];
  startPendingOperation(): Promise<unknown>;
}

const conformantReleasedKinds = new Set<string>();

describe("Runtime input identity", () => {
  it("rejects a partially identified ClawChat context", () => {
    expect(
      runtimeInputIdentity(
        [
          "<clawchat_turn_context>",
          JSON.stringify({
            origin: "clawchat",
            message_id: "anchor",
            content_digest: "sha256:anchor",
            group_batch: { messages: [{ message_id: "missing-digest" }] },
          }),
          "</clawchat_turn_context>",
          "input",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("rejects a Group Message Batch without exactly one matching anchor", () => {
    const context = (messages: Array<{ message_id: string; content_digest: string }>) =>
      [
        "<clawchat_turn_context>",
        JSON.stringify({
          origin: "clawchat",
          message_id: "anchor",
          content_digest: "digest-anchor",
          group_batch: { messages },
        }),
        "</clawchat_turn_context>",
        "input",
      ].join("\n");

    expect(runtimeInputIdentity(context([{ message_id: "other", content_digest: "digest-other" }]))).toBeNull();
    expect(
      runtimeInputIdentity(
        context([
          { message_id: "anchor", content_digest: "digest-anchor" },
          { message_id: "anchor", content_digest: "digest-anchor" },
        ]),
      ),
    ).toBeNull();
  });

  it("rejects conflicting digests for one ClawChat message identity", () => {
    expect(
      runtimeInputIdentity(
        [
          "<clawchat_turn_context>",
          JSON.stringify({
            origin: "clawchat",
            message_id: "anchor",
            content_digest: "digest-anchor",
            group_batch: {
              messages: [
                { message_id: "other", content_digest: "digest-actionable" },
                { message_id: "anchor", content_digest: "digest-anchor" },
              ],
            },
            recent_group_context: [{ message_id: "other", content_digest: "digest-context" }],
          }),
          "</clawchat_turn_context>",
          "input",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("rejects duplicate and overlapping group roles even when their digests match", () => {
    const identity = (
      messages: Array<{ message_id: string; content_digest: string }>,
      context: Array<{ message_id: string; content_digest: string }>,
    ) =>
      runtimeInputIdentity(
        [
          "<clawchat_turn_context>",
          JSON.stringify({
            origin: "clawchat",
            message_id: "anchor",
            content_digest: "digest-anchor",
            group_batch: { messages },
            recent_group_context: context,
          }),
          "</clawchat_turn_context>",
          "input",
        ].join("\n"),
      );
    const anchor = { message_id: "anchor", content_digest: "digest-anchor" };
    const other = { message_id: "other", content_digest: "digest-other" };
    const context = { message_id: "context", content_digest: "digest-context" };

    expect(identity([other, other, anchor], [])).toBeNull();
    expect(identity([other, anchor], [context, context])).toBeNull();
    expect(identity([other, anchor], [other])).toBeNull();
  });
});

function runtimeAdapterConformance(name: string, createHarness: () => AdapterHarness, releasedKind?: string): void {
  if (releasedKind) conformantReleasedKinds.add(releasedKind);
  describe(`${name} Runtime Adapter conformance`, () => {
    if (releasedKind) {
      it("exposes authoritative Runtime input reconciliation", () => {
        const { adapter } = createHarness();
        expect(adapter.reconcileInput).toBeInstanceOf(Function);
      });
    }

    it("reports capabilities and distinguishes unsupported from supported-empty results", async () => {
      const { adapter, binding } = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);

      expect(registry.lifecycleCapabilities(binding)).toEqual(
        adapter.lifecycleCapabilities ?? {
          archive: Boolean(adapter.archiveThread),
          restore: Boolean(adapter.unarchiveThread),
          delete: Boolean(adapter.deleteThread),
        },
      );
      const models = await registry.listModels(binding);
      if (adapter.listModels) expect(models).toEqual(expect.any(Array));
      else expect(models).toBeNull();
      expect(
        await registry.discoverThreads(binding, {
          projectId: null,
          workingDirectory: "/tmp",
          skipGitRepoCheck: true,
        }),
      ).toEqual([]);
      await registry.close();
    });

    it("returns stable Runtime Activity identity and ordering", async () => {
      const { adapter, binding } = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);

      const first = await registry.readActivity(binding, "thread-1");
      const second = await registry.readActivity(binding, "thread-1");

      expect(second).toEqual(first);
      expect(first.activities).toHaveLength(201);
      expect(new Set(first.activities.map((activity) => activity.id))).toHaveProperty("size", 201);
      expect(new Set(first.activities.map((activity) => activity.position))).toHaveProperty("size", 201);
      expect(first.activities.every((activity) => runtimeActivityOrdinal(activity.position) !== null)).toBe(true);
      expect(first.activities.every((activity) => activity.text === "same output")).toBe(true);
      expect(
        first.activities.flatMap((activity) => activity.aliases ?? []).every((alias) => alias.trim().length > 0),
      ).toBe(true);
      await registry.close();
    });

    it("converges alias, current-state, replay, and out-of-order Activity through Projection", async () => {
      const { adapter, binding } = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
      const directory = await mkdtemp(join(tmpdir(), "connect-adapter-conformance-projection-"));
      const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
      try {
        const config = defaultConfig();
        config.agents = { codex: binding };
        await store.upsertRuntimeSession({
          chatId: "conformance",
          sessionId: "conformance",
          agentId: "codex",
          runtimeSessionId: "thread-1",
          name: "Conformance",
          hasMessages: true,
          isCurrent: true,
        });
        const session = await store.getCurrentRuntimeSession("conformance", "codex");
        if (!session) throw new Error("conformance Session was not created");
        const [earlier, later] = (await registry.readActivity(binding, "thread-1")).activities;
        if (!earlier || !later) throw new Error("conformance Adapter returned insufficient Activity");
        const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters: registry });

        await projection.upsertRuntimeActivity(session.sessionRef, {
          id: "turn-marker",
          position: "0.0",
          parentId: null,
          kind: "progress",
          text: "turn started",
          state: "streaming",
          source: "live",
        });
        await projection.upsertRuntimeActivity(session.sessionRef, {
          ...later,
          text: "later",
          source: "live",
        });
        await projection.upsertRuntimeActivity(session.sessionRef, {
          ...earlier,
          id: "live-earlier",
          text: "earlier streaming",
          state: "streaming",
          source: "live",
        });
        const completedEarlier = {
          ...earlier,
          aliases: [...(earlier.aliases ?? []), "live-earlier"],
          text: "earlier complete",
          state: "complete" as const,
          source: "history" as const,
        };
        await projection.upsertRuntimeActivity(session.sessionRef, completedEarlier);
        await projection.upsertRuntimeActivity(session.sessionRef, completedEarlier);

        const blocks = await store.listTranscriptBlocks(session.sessionRef);
        expect(blocks.map((block) => block.plainText)).toEqual(["turn started", "earlier complete", "later"]);
        expect(new Set(blocks.map((block) => block.sequence)).size).toBe(3);
      } finally {
        await store.close();
        await registry.close();
      }
    });

    it("applies supported lifecycle operations idempotently", async () => {
      const harness = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(harness.adapter)]);
      harness.activateThread();

      const capabilities = registry.lifecycleCapabilities(harness.binding);
      if (capabilities.archive && capabilities.restore) {
        await registry.archiveThread(harness.binding, "thread-1");
        await registry.archiveThread(harness.binding, "thread-1");
        await registry.unarchiveThread(harness.binding, "thread-1");
        await registry.unarchiveThread(harness.binding, "thread-1");
      } else {
        await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toMatchObject({
          code: "unsupported",
        });
        await expect(registry.unarchiveThread(harness.binding, "thread-1")).rejects.toMatchObject({
          code: "unsupported",
        });
      }
      if (capabilities.delete) {
        await registry.deleteThread(harness.binding, "thread-1");
        await registry.deleteThread(harness.binding, "thread-1");
      } else {
        await expect(registry.deleteThread(harness.binding, "thread-1")).rejects.toMatchObject({
          code: "unsupported",
        });
      }

      expect(harness.lifecycleCalls()).toEqual(
        capabilities.archive ? ["archive", "restore", "delete"] : capabilities.delete ? ["delete"] : [],
      );
      if (capabilities.archive)
        await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toMatchObject({
          code: "not-found",
        });
      await registry.close();
    });

    it("normalizes native lifecycle failures into stable errors", async () => {
      const harness = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(harness.adapter)]);
      harness.activateThread();
      if (!registry.lifecycleCapabilities(harness.binding).archive) {
        await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toBeInstanceOf(RuntimeLifecycleError);
        await registry.close();
        return;
      }
      harness.failNextArchive();

      await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toBeInstanceOf(RuntimeLifecycleError);
      await expect(registry.archiveThread(harness.binding, "thread-1")).resolves.toBeUndefined();
      await registry.close();
    });

    it("closes binding-owned resources exactly once", async () => {
      const harness = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(harness.adapter)]);

      await registry.prepare(harness.binding);
      await registry.close();
      await registry.close();

      expect(harness.closeCount()).toBe(1);
    });

    it("settles pending binding operations when resources close", async () => {
      const harness = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(harness.adapter)]);
      await registry.prepare(harness.binding);
      const pending = harness.startPendingOperation();
      void pending.catch(() => undefined);
      await Promise.resolve();

      await registry.close();

      await expect(pending).rejects.toThrow("binding closed");
    });
  });
}

runtimeAdapterConformance("reference", () => {
  let closes = 0;
  let closed = false;
  let state: "active" | "archived" | "deleted" = "deleted";
  let failArchive = false;
  let pendingReject: ((error: Error) => void) | null = null;
  const lifecycleCalls: string[] = [];
  return {
    binding: { kind: "codex" },
    activateThread: () => {
      state = "active";
    },
    closeCount: () => closes,
    failNextArchive: () => {
      failArchive = true;
    },
    lifecycleCalls: () => lifecycleCalls,
    startPendingOperation: async () =>
      await new Promise((_, reject) => {
        pendingReject = reject;
      }),
    adapter: {
      kind: "codex",
      modes: [],
      lifecycleCapabilities: { archive: true, restore: true, delete: true },
      discoverAllThreads: async () =>
        state === "active" ? [{ runtimeThreadId: "thread-1", name: null, updatedAt: 1 }] : [],
      discoverArchivedThreads: async () =>
        state === "archived" ? [{ runtimeThreadId: "thread-1", name: null, updatedAt: 1, isArchived: true }] : [],
      archiveThread: async () => {
        if (failArchive) {
          failArchive = false;
          throw new Error("native mutation is busy");
        }
        lifecycleCalls.push("archive");
        state = "archived";
      },
      unarchiveThread: async () => {
        lifecycleCalls.push("restore");
        state = "active";
      },
      deleteThread: async () => {
        lifecycleCalls.push("delete");
        state = "deleted";
      },
      readActivity: async () => ({
        completeness: "complete",
        limitations: [],
        activities: Array.from({ length: 201 }, (_, index) => ({
          id: `activity-${index}`,
          aliases: [`live-${index}`],
          position: `0.${index + 1}`,
          parentId: null,
          kind: "assistant" as const,
          text: "same output",
          state: "complete" as const,
          source: "history" as const,
        })),
      }),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      close: async () => {
        if (closed) return;
        closed = true;
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    },
  };
});

runtimeAdapterConformance(
  "Codex",
  () => {
    let closes = 0;
    let state: "active" | "archived" | "deleted" = "deleted";
    let failArchive = false;
    let pendingReject: ((error: Error) => void) | null = null;
    const lifecycleCalls: string[] = [];
    const appServer = {
      listModels: async () =>
        pendingReject
          ? await new Promise((_, reject) => {
              pendingReject = reject;
            })
          : { data: [], nextCursor: null },
      listThreads: async (params: { archived?: boolean }) => ({
        data:
          (params.archived === true && state === "archived") || (params.archived !== true && state === "active")
            ? [
                {
                  id: "thread-1",
                  preview: "",
                  name: null,
                  createdAt: 1,
                  updatedAt: 1,
                  recencyAt: 1,
                  cwd: "/tmp",
                },
              ]
            : [],
        nextCursor: null,
      }),
      readThread: async () => ({
        thread: {
          id: "thread-1",
          preview: "",
          name: null,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: 1,
          cwd: "/tmp",
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: Array.from({ length: 201 }, (_, index) => ({
                type: "agentMessage",
                id: `activity-${index}`,
                text: "same output",
              })),
            },
          ],
        },
      }),
      archiveThread: async () => {
        if (failArchive) {
          failArchive = false;
          throw new Error("native mutation is busy");
        }
        lifecycleCalls.push("archive");
        state = "archived";
      },
      unarchiveThread: async () => {
        lifecycleCalls.push("restore");
        state = "active";
        return { thread: { id: "thread-1" } };
      },
      deleteThread: async () => {
        lifecycleCalls.push("delete");
        state = "deleted";
      },
      startThread: async () => ({ thread: { id: "thread-1" } }),
      resumeThread: async () => ({ thread: { id: "thread-1" } }),
      startTurn: async () => ({ turn: { id: "turn-1", status: "completed", error: null } }),
      interruptTurn: async () => undefined,
      onNotification: () => () => undefined,
      onRequest: () => () => undefined,
      close: async () => {
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    };
    return {
      binding: { kind: "codex", env: { CODEX_HOME: "/tmp/connect-runtime-adapter-conformance" } },
      activateThread: () => {
        state = "active";
      },
      closeCount: () => closes,
      failNextArchive: () => {
        failArchive = true;
      },
      lifecycleCalls: () => lifecycleCalls,
      startPendingOperation: async () => {
        pendingReject = () => undefined;
        return await appServer.listModels();
      },
      adapter: createCodexRuntimeAdapter({
        createAppServer: async () =>
          appServer as unknown as import("../src/runtime/codex-app-server").CodexAppServerClient,
      }),
    };
  },
  "codex",
);

runtimeAdapterConformance(
  "OpenCode",
  () => {
    let closes = 0;
    let state: "active" | "deleted" = "active";
    let pendingReject: ((error: Error) => void) | null = null;
    const lifecycleCalls: string[] = [];
    const messages: OpenCodeMessage[] = [
      {
        info: {
          id: "message-1",
          sessionID: "thread-1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "test", modelID: "model" },
        },
        parts: Array.from({ length: 201 }, (_, index) => ({
          id: `activity-${index}`,
          sessionID: "thread-1",
          messageID: "message-1",
          type: "text" as const,
          text: "same output",
        })),
      },
    ];
    const session = {
      id: "thread-1",
      slug: "thread-1",
      projectID: "project-1",
      directory: "/repo",
      title: "Conformance",
      version: "1.18.10",
      time: { created: 1, updated: 1 },
    };
    const client: OpenCodeServerClient = {
      version: "1.18.10",
      health: async () => ({ healthy: true, version: "1.18.10" }),
      listAgents: async () =>
        pendingReject
          ? await new Promise((_, reject) => {
              pendingReject = reject;
            })
          : [],
      listCommands: async () => [],
      listProviders: async () => ({ all: [], connected: [], default: {} }),
      listSessions: async () => (state === "active" ? [session] : []),
      getSession: async () => {
        if (state !== "active") throw new Error("not found");
        return session;
      },
      createSession: async () => session,
      deleteSession: async () => {
        if (state === "deleted") return false;
        lifecycleCalls.push("delete");
        state = "deleted";
        return true;
      },
      sessionStatus: async () => ({}),
      messages: async () => messages,
      promptAsync: async () => undefined,
      runCommand: async () => undefined,
      abortSession: async () => true,
      events: (signal, onConnected) => {
        onConnected?.();
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        };
      },
      replyPermission: async () => true,
      replyQuestion: async () => true,
      rejectQuestion: async () => true,
      close: async () => {
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    };
    return {
      binding: { kind: "opencode" },
      activateThread: () => {
        state = "active";
      },
      closeCount: () => closes,
      failNextArchive: () => undefined,
      lifecycleCalls: () => lifecycleCalls,
      startPendingOperation: async () => {
        pendingReject = () => undefined;
        return await client.listAgents("/repo");
      },
      adapter: createOpenCodeRuntimeAdapter({ createServer: async () => client }),
    };
  },
  "opencode",
);

runtimeAdapterConformance(
  "WorkBuddy",
  () => {
    let closes = 0;
    let closed = false;
    let active = false;
    let pending = false;
    let pendingReject: ((error: Error) => void) | null = null;
    const activities = Array.from({ length: 201 }, (_, index) => ({
      id: `activity-${index}`,
      aliases: [`live-${index}`],
      position: `0.${index + 1}`,
      parentId: null,
      kind: "assistant" as const,
      text: "same output",
      state: "complete" as const,
      source: "history" as const,
    }));
    const source: WorkBuddyRuntimeSource = {
      listTasks: async () => (active ? [{ id: "thread-1", title: "Task", workspace: "/tmp", updatedAt: 1 }] : []),
      findTask: async () => ({ id: "thread-1", title: "Task", workspace: "/tmp", updatedAt: 1 }),
      attachTask: async () =>
        pending
          ? await new Promise((_, reject) => {
              pendingReject = reject;
            })
          : { activities, completeness: "complete", limitations: [] },
      close: async () => {
        if (closed) return;
        closed = true;
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    };
    return {
      binding: { kind: "workbuddy", profile: "workbuddy-ai" },
      activateThread: () => {
        active = true;
      },
      closeCount: () => closes,
      failNextArchive: () => undefined,
      lifecycleCalls: () => [],
      startPendingOperation: async () => {
        active = true;
        pending = true;
        return await source.attachTask({ profile: "workbuddy-ai", taskId: "thread-1", workspace: "/tmp" });
      },
      adapter: createWorkBuddyRuntimeAdapter({ createSource: () => source }),
    };
  },
  "workbuddy",
);

describe("released Runtime Adapter conformance gate", () => {
  it("registers every released Runtime Adapter kind in the shared suite", () => {
    expect([...conformantReleasedKinds].sort()).toEqual(
      releasedRuntimeAdapters()
        .map((adapter) => adapter.kind)
        .sort(),
    );
  });
});
