import { describe, expect, it } from "bun:test";
import { createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";
import type { AgentBindingConfig } from "../src/types";

interface AdapterHarness {
  adapter: ConnectRuntimeAdapter;
  binding: AgentBindingConfig;
  closeCount(): number;
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
      expect(await registry.discoverAllThreads(binding)).toEqual([]);
      await registry.close();
    });

    it("returns stable Runtime Activity identity and ordering", async () => {
      const { adapter, binding } = createHarness();
      const registry = new RuntimeAdapterRegistry([adapter]);

      const first = await registry.readActivity(binding, "thread-1");
      const second = await registry.readActivity(binding, "thread-1");

      expect(second).toEqual(first);
      expect(first.activities.map((activity) => [activity.id, activity.position])).toEqual([["activity-1", "0"]]);
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
  return {
    binding: { kind: "codex" },
    closeCount: () => closes,
    adapter: {
      kind: "codex",
      modes: [],
      lifecycleCapabilities: { archive: false, restore: false, delete: false },
      discoverAllThreads: async () => [],
      readActivity: async () => ({
        completeness: "complete",
        limitations: [],
        activities: [
          {
            id: "activity-1",
            position: "0",
            parentId: null,
            kind: "assistant",
            text: "done",
            state: "complete",
            source: "history",
          },
        ],
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
  const appServer = {
    listModels: async () => ({ data: [], nextCursor: null }),
    listThreads: async () => ({ data: [], nextCursor: null }),
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
            items: [{ type: "agentMessage", id: "activity-1", text: "done" }],
          },
        ],
      },
    }),
    archiveThread: async () => undefined,
    unarchiveThread: async () => ({ thread: { id: "thread-1" } }),
    deleteThread: async () => undefined,
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
    closeCount: () => closes,
    adapter: createCodexRuntimeAdapter({
      createAppServer: async () =>
        appServer as unknown as import("../src/runtime/codex-app-server").CodexAppServerClient,
    }),
  };
});
