import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { type ConnectRuntimeAdapter, RuntimeLifecycleError, runtimeActivityOrdinal } from "../src/runtime/types";
import type { AgentBindingConfig } from "../src/types";
import { fixedRuntimeAdapter } from "./runtime-adapter-fixture";

export interface AdapterHarness {
  adapter?: ConnectRuntimeAdapter;
  registry?: RuntimeAdapterRegistry;
  binding: AgentBindingConfig;
  activateThread(): void;
  closeCount(): number;
  failNextArchive(): void;
  lifecycleCalls(): string[];
  startPendingOperation(): Promise<unknown>;
  dispose?(): Promise<void>;
}

export function runtimeAdapterConformance(
  name: string,
  createHarness: () => AdapterHarness | Promise<AdapterHarness>,
  requiresInputReconciliation = false,
): void {
  describe(`${name} Runtime Adapter conformance`, () => {
    if (requiresInputReconciliation) {
      it("exposes authoritative Runtime input reconciliation", async () => {
        const harness = await createHarness();
        if (!harness.adapter) throw new Error("Runtime conformance requires a direct Adapter harness");
        expect(harness.adapter.reconcileInput).toBeInstanceOf(Function);
      });
    }

    it("reports capabilities and distinguishes unsupported from supported-empty results", async () => {
      const harness = await createHarness();
      const registry = runtimeRegistry(harness);
      const { adapter, binding } = harness;
      if (adapter) {
        expect(registry.lifecycleCapabilities(binding)).toEqual(
          adapter.lifecycleCapabilities ?? {
            archive: Boolean(adapter.archiveThread),
            restore: Boolean(adapter.unarchiveThread),
            delete: Boolean(adapter.deleteThread),
          },
        );
      } else {
        expect(
          Object.values(registry.lifecycleCapabilities(binding)).every((value) => typeof value === "boolean"),
        ).toBe(true);
      }
      const models = await registry.listModels(binding);
      if (!adapter || adapter.listModels) expect(models).toEqual(expect.any(Array));
      else expect(models).toBeNull();
      expect(
        await registry.discoverThreads(binding, {
          projectId: null,
          workingDirectory: "/tmp",
          skipGitRepoCheck: true,
        }),
      ).toEqual([]);
      await registry.close();
      await harness.dispose?.();
    });

    it("returns stable Runtime Activity identity and ordering", async () => {
      const harness = await createHarness();
      const { binding } = harness;
      const registry = runtimeRegistry(harness);
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
      await harness.dispose?.();
    });

    it("converges alias, current-state, replay, and out-of-order Activity through Projection", async () => {
      const harness = await createHarness();
      const { binding } = harness;
      const registry = runtimeRegistry(harness);
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
        await projection.upsertRuntimeActivity(session.sessionRef, { ...later, text: "later", source: "live" });
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
        await harness.dispose?.();
      }
    });

    it("applies supported lifecycle operations idempotently", async () => {
      const harness = await createHarness();
      const registry = runtimeRegistry(harness);
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
        await expect(registry.deleteThread(harness.binding, "thread-1")).rejects.toMatchObject({ code: "unsupported" });
      }
      expect(harness.lifecycleCalls()).toEqual(
        capabilities.archive ? ["archive", "restore", "delete"] : capabilities.delete ? ["delete"] : [],
      );
      if (capabilities.archive) {
        await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toMatchObject({ code: "not-found" });
      }
      await registry.close();
      await harness.dispose?.();
    });

    it("normalizes native lifecycle failures into stable errors", async () => {
      const harness = await createHarness();
      const registry = runtimeRegistry(harness);
      harness.activateThread();
      if (!registry.lifecycleCapabilities(harness.binding).archive) {
        await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toBeInstanceOf(RuntimeLifecycleError);
        await registry.close();
        await harness.dispose?.();
        return;
      }
      harness.failNextArchive();
      await expect(registry.archiveThread(harness.binding, "thread-1")).rejects.toBeInstanceOf(RuntimeLifecycleError);
      await expect(registry.archiveThread(harness.binding, "thread-1")).resolves.toBeUndefined();
      await registry.close();
      await harness.dispose?.();
    });

    it("closes binding-owned resources exactly once", async () => {
      const harness = await createHarness();
      const registry = runtimeRegistry(harness);
      await registry.prepare(harness.binding);
      await registry.close();
      await registry.close();
      await harness.dispose?.();
      expect(harness.closeCount()).toBe(1);
    });

    it("settles pending binding operations when resources close", async () => {
      const harness = await createHarness();
      const registry = runtimeRegistry(harness);
      await registry.prepare(harness.binding);
      const pending = harness.startPendingOperation();
      void pending.catch(() => undefined);
      await Promise.resolve();
      await registry.close();
      await expect(pending).rejects.toThrow();
      await harness.dispose?.();
    });
  });
}

function runtimeRegistry(harness: AdapterHarness): RuntimeAdapterRegistry {
  if (harness.registry) return harness.registry;
  if (harness.adapter) return new RuntimeAdapterRegistry([fixedRuntimeAdapter(harness.adapter)]);
  throw new Error("Runtime Adapter conformance harness requires an Adapter or installed registry");
}
