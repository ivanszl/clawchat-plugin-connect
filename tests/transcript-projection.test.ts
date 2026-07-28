import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { RuntimeActivity } from "../src/runtime/types";
import { createStateStore } from "../src/state";

function liveActivity(
  id: string,
  kind: RuntimeActivity["kind"],
  text: string,
  data: Record<string, unknown> = {},
  state: RuntimeActivity["state"] = "complete",
): RuntimeActivity {
  return { id, position: id, parentId: null, kind, text, state, source: "live", data };
}

describe("Connect Transcript Projection", () => {
  it("maps Runtime Activity positions into stable sequence despite out-of-order arrival", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-ordering-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-ordering",
        sessionId: "session-ordering",
        agentId: "codex",
        runtimeSessionId: "thread-ordering",
        name: "Ordering",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-ordering", "codex");
      if (!session) throw new Error("test Session was not created");
      const projection = new TranscriptProjection({
        stateStore: store,
        config: defaultConfig(),
        runtimeAdapters: new RuntimeAdapterRegistry([]),
      });
      const positioned = (id: string, position: string): RuntimeActivity => ({
        id,
        position,
        parentId: null,
        kind: "assistant",
        text: id,
        state: "complete",
        source: "live",
      });

      await projection.upsertRuntimeActivity(session.sessionRef, positioned("later", "1.2"));
      await projection.upsertRuntimeActivity(session.sessionRef, positioned("earlier", "0.3"));
      await projection.upsertRuntimeActivity(session.sessionRef, positioned("middle", "1.1"));

      const blocks = await store.listTranscriptBlocks(session.sessionRef);
      expect(blocks.map((block) => block.plainText)).toEqual(["earlier", "middle", "later"]);
      expect(blocks.map((block) => block.sequence)).toEqual([1_000_003, 2_000_001, 2_000_002]);
    } finally {
      await store.close();
    }
  });

  it("projects running app-server tool items as collapsible tool-call blocks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-tool-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-1",
        sessionId: "session-1",
        agentId: "codex",
        runtimeSessionId: "thread-1",
        name: "Tool projection",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-1", "codex");
      if (!session) throw new Error("test Session was not created");
      const projection = new TranscriptProjection({
        stateStore: store,
        config: defaultConfig(),
        runtimeAdapters: new RuntimeAdapterRegistry([]),
      });

      const block = await projection.upsertRuntimeActivity(
        session.sessionRef,
        liveActivity(
          "mcp-1",
          "tool",
          "Codex calling MCP tool: github/search",
          {
            itemType: "mcpToolCall",
            server: "github",
            tool: "search",
            status: "running",
            title: "MCP · github/search",
          },
          "streaming",
        ),
      );

      expect(block).toMatchObject({
        type: "tool-call",
        title: "MCP · github/search",
        status: "running",
        state: "streaming",
      });
    } finally {
      await store.close();
    }
  });

  it("preserves fallback provenance and adapter completeness during history reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-fallback-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-1",
        sessionId: "session-1",
        agentId: "codex",
        runtimeSessionId: "thread-1",
        name: "Fallback projection",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-1", "codex");
      if (!session) throw new Error("test Session was not created");
      const config = defaultConfig();
      config.agents = { codex: { kind: "codex" } };
      const runtimeAdapters = new RuntimeAdapterRegistry([
        {
          kind: "codex",
          modes: ["workspace-write"],
          readActivity: async () => ({
            completeness: "partial",
            limitations: ["correlation"],
            activities: [
              {
                id: "rollout:call-1",
                position: "0",
                parentId: null,
                kind: "tool",
                text: "Codex tool · exec\n\nOutput:\nok",
                state: "complete",
                source: "fallback",
                data: { title: "Codex tool · exec", status: "completed" },
              },
            ],
          }),
          start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
        },
      ]);
      const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters });

      await projection.reconcile(session);

      expect(projection.completeness(session.sessionRef)).toBe("partial");
      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          type: "tool-call",
          title: "Codex tool · exec",
          runtimeSource: "fallback",
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("reconciles history onto an already projected live item when the Runtime changes its item id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-live-history-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-1",
        sessionId: "session-1",
        agentId: "codex",
        runtimeSessionId: "thread-1",
        name: "Live history reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-1", "codex");
      if (!session) throw new Error("test Session was not created");
      const config = defaultConfig();
      config.agents = { codex: { kind: "codex" } };
      const runtimeAdapters = new RuntimeAdapterRegistry([
        {
          kind: "codex",
          modes: ["workspace-write"],
          readActivity: async () => ({
            completeness: "complete",
            limitations: [],
            activities: [
              {
                id: "history-message-1",
                aliases: ["live-message-1"],
                position: "1",
                parentId: null,
                kind: "assistant",
                text: "first reply",
                state: "complete",
                source: "history",
              },
              {
                id: "history-message-2",
                aliases: ["live-message-2"],
                position: "2",
                parentId: null,
                kind: "assistant",
                text: "first reply",
                state: "complete",
                source: "history",
              },
              {
                id: "history-command-1",
                aliases: ["live-command-1"],
                position: "3",
                parentId: null,
                kind: "command",
                text: "tests passed",
                state: "complete",
                source: "history",
                data: { command: "bun test", status: "completed", exitCode: 0 },
              },
              {
                id: "history-file-1",
                aliases: ["live-file-1"],
                position: "4",
                parentId: null,
                kind: "file-change",
                text: "updated a.ts",
                state: "complete",
                source: "history",
                data: {
                  status: "completed",
                  changes: [{ path: "a.ts", kind: "update", diff: "+fixed" }],
                },
              },
            ],
          }),
          start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
        },
      ]);
      const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters });
      await projection.upsertRuntimeActivity(
        session.sessionRef,
        liveActivity("live-message-1", "assistant", "first reply"),
      );
      await projection.upsertRuntimeActivity(
        session.sessionRef,
        liveActivity("live-message-2", "assistant", "first reply"),
      );
      await projection.upsertRuntimeActivity(
        session.sessionRef,
        liveActivity("live-command-1", "command", "tests passed", {
          command: "bun test",
          output: "tests passed",
          status: "completed",
          exitCode: 0,
        }),
      );
      await projection.upsertRuntimeActivity(
        session.sessionRef,
        liveActivity("live-file-1", "file-change", "updated a.ts", {
          status: "completed",
          changes: [{ path: "a.ts", kind: "update", diff: "+fixed" }],
        }),
      );

      await projection.reconcile(session);

      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          type: "message",
          role: "assistant",
          markdown: "first reply",
          runtimeSource: "history",
        },
        {
          type: "message",
          role: "assistant",
          markdown: "first reply",
          runtimeSource: "history",
        },
        {
          type: "command",
          command: "bun test",
          output: "tests passed",
          runtimeSource: "history",
        },
        {
          type: "file-change",
          files: [{ path: "a.ts", kind: "update", diff: "+fixed" }],
          runtimeSource: "history",
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("reconciles more than 200 identical activities by Adapter-provided aliases without duplication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-activity-aliases-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-1",
        sessionId: "session-1",
        agentId: "codex",
        runtimeSessionId: "thread-1",
        name: "Alias reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-1", "codex");
      if (!session) throw new Error("test Session was not created");
      const config = defaultConfig();
      config.agents = { codex: { kind: "codex" } };
      const runtimeAdapters = new RuntimeAdapterRegistry([
        {
          kind: "codex",
          modes: [],
          readActivity: async () => ({
            completeness: "complete",
            limitations: [],
            activities: Array.from({ length: 201 }, (_, index) => ({
              id: `history-${index}`,
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
        },
      ]);
      const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters });
      for (let index = 0; index < 201; index += 1) {
        await projection.upsertRuntimeActivity(
          session.sessionRef,
          liveActivity(`live-${index}`, "assistant", "same output"),
        );
      }

      await projection.reconcile(session);

      expect(await store.countTranscriptBlocks(session.sessionRef)).toBe(201);
    } finally {
      await store.close();
    }
  });
});
