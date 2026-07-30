import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { releasedRuntimeAdapters } from "../src/runtime/released-adapters";
import { type ConnectRuntimeAdapter, RuntimeLifecycleError, runtimeActivityOrdinal } from "../src/runtime/types";
import { createStateStore } from "../src/state";
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

function runtimeAdapterConformance(name: string, createHarness: () => AdapterHarness, releasedKind?: string): void {
  if (releasedKind) conformantReleasedKinds.add(releasedKind);
  describe(`${name} Runtime Adapter conformance`, () => {
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
          additionalDirectories: [],
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

      await registry.archiveThread(harness.binding, "thread-1");
      await registry.archiveThread(harness.binding, "thread-1");
      await registry.unarchiveThread(harness.binding, "thread-1");
      await registry.unarchiveThread(harness.binding, "thread-1");
      await registry.deleteThread(harness.binding, "thread-1");
      await registry.deleteThread(harness.binding, "thread-1");

      expect(harness.lifecycleCalls()).toEqual(["archive", "restore", "delete"]);
      await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toMatchObject({ code: "not-found" });
      await registry.close();
    });

    it("normalizes native lifecycle failures into stable errors", async () => {
      const harness = createHarness();
      const registry = new RuntimeAdapterRegistry([fixedRuntimeAdapter(harness.adapter)]);
      harness.activateThread();
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

describe("released Runtime Adapter conformance gate", () => {
  it("registers every released Runtime Adapter kind in the shared suite", () => {
    expect([...conformantReleasedKinds].sort()).toEqual(
      releasedRuntimeAdapters()
        .map((adapter) => adapter.kind)
        .sort(),
    );
  });
});
