import { describe, expect, it } from "bun:test";
import { createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";
import type { AgentBindingConfig } from "../src/types";

interface AdapterHarness {
  adapter: ConnectRuntimeAdapter;
  binding: AgentBindingConfig;
  activateThread(): void;
  closeCount(): number;
  lifecycleCalls(): string[];
}

function runtimeAdapterConformance(name: string, createHarness: () => AdapterHarness): void {
  describe(`${name} Runtime Adapter conformance`, () => {
    it("reports capabilities and distinguishes unsupported from supported-empty results", async () => {
      const { adapter, binding } = createHarness();
      const registry = new RuntimeAdapterRegistry([adapter]);

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
      const registry = new RuntimeAdapterRegistry([adapter]);

      const first = await registry.readActivity(binding, "thread-1");
      const second = await registry.readActivity(binding, "thread-1");

      expect(second).toEqual(first);
      expect(first.activities).toHaveLength(201);
      expect(new Set(first.activities.map((activity) => activity.id))).toHaveProperty("size", 201);
      expect(new Set(first.activities.map((activity) => activity.position))).toHaveProperty("size", 201);
      expect(first.activities.every((activity) => activity.text === "same output")).toBe(true);
      await registry.close();
    });

    it("applies supported lifecycle operations idempotently", async () => {
      const harness = createHarness();
      const registry = new RuntimeAdapterRegistry([harness.adapter]);
      harness.activateThread();

      await registry.archiveThread(harness.binding, "thread-1");
      await registry.archiveThread(harness.binding, "thread-1");
      await registry.unarchiveThread(harness.binding, "thread-1");
      await registry.unarchiveThread(harness.binding, "thread-1");
      await registry.deleteThread(harness.binding, "thread-1");
      await registry.deleteThread(harness.binding, "thread-1");

      expect(harness.lifecycleCalls()).toEqual(["archive", "restore", "delete"]);
      await registry.close();
    });

    it("closes binding-owned resources exactly once", async () => {
      const harness = createHarness();
      const registry = new RuntimeAdapterRegistry([harness.adapter]);

      await registry.prepare(harness.binding);
      await registry.close();
      await registry.close();

      expect(harness.closeCount()).toBe(1);
    });
  });
}

runtimeAdapterConformance("reference", () => {
  let closes = 0;
  let closed = false;
  let state: "active" | "archived" | "deleted" = "deleted";
  const lifecycleCalls: string[] = [];
  return {
    binding: { kind: "codex" },
    activateThread: () => {
      state = "active";
    },
    closeCount: () => closes,
    lifecycleCalls: () => lifecycleCalls,
    adapter: {
      kind: "codex",
      modes: [],
      lifecycleCapabilities: { archive: true, restore: true, delete: true },
      discoverAllThreads: async () =>
        state === "active" ? [{ runtimeThreadId: "thread-1", name: null, updatedAt: 1 }] : [],
      discoverArchivedThreads: async () =>
        state === "archived" ? [{ runtimeThreadId: "thread-1", name: null, updatedAt: 1, isArchived: true }] : [],
      archiveThread: async () => {
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
          position: `${index}`,
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
      },
    },
  };
});

runtimeAdapterConformance("Codex", () => {
  let closes = 0;
  let state: "active" | "archived" | "deleted" = "deleted";
  const lifecycleCalls: string[] = [];
  const appServer = {
    listModels: async () => ({ data: [], nextCursor: null }),
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
    },
  };
  return {
    binding: { kind: "codex", env: { CODEX_HOME: "/tmp/connect-runtime-adapter-conformance" } },
    activateThread: () => {
      state = "active";
    },
    closeCount: () => closes,
    lifecycleCalls: () => lifecycleCalls,
    adapter: createCodexRuntimeAdapter({
      createAppServer: async () =>
        appServer as unknown as import("../src/runtime/codex-app-server").CodexAppServerClient,
    }),
  };
});
