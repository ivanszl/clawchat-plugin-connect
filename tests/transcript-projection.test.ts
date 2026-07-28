import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { createStateStore } from "../src/state";

describe("Connect Transcript Projection", () => {
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

      const block = await projection.appendRuntimeOutput(session.sessionRef, {
        kind: "progress",
        text: "Codex calling MCP tool: github/search",
        itemId: "mcp-1",
        state: "streaming",
        data: { itemType: "mcpToolCall", server: "github", tool: "search", status: "running" },
      });

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
          readTranscript: async () => ({
            completeness: "partial",
            entries: [
              {
                id: "rollout:call-1",
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
          readTranscript: async () => ({
            completeness: "complete",
            entries: [
              {
                id: "history-message-1",
                kind: "assistant",
                text: "first reply",
                state: "complete",
                source: "history",
              },
              {
                id: "history-message-2",
                kind: "assistant",
                text: "first reply",
                state: "complete",
                source: "history",
              },
              {
                id: "history-command-1",
                kind: "command",
                text: "tests passed",
                state: "complete",
                source: "history",
                data: { command: "bun test", status: "completed", exitCode: 0 },
              },
              {
                id: "history-file-1",
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
      await projection.appendRuntimeOutput(session.sessionRef, {
        kind: "final",
        text: "first reply",
        itemId: "live-message-1",
        state: "complete",
        data: { itemType: "agentMessage" },
      });
      await projection.appendRuntimeOutput(session.sessionRef, {
        kind: "final",
        text: "first reply",
        itemId: "live-message-2",
        state: "complete",
        data: { itemType: "agentMessage" },
      });
      await projection.appendRuntimeOutput(session.sessionRef, {
        kind: "tool",
        text: "tests passed",
        itemId: "live-command-1",
        state: "complete",
        data: {
          itemType: "commandExecution",
          command: "bun test",
          output: "tests passed",
          status: "completed",
          exitCode: 0,
        },
      });
      await projection.appendRuntimeOutput(session.sessionRef, {
        kind: "tool",
        text: "updated a.ts",
        itemId: "live-file-1",
        state: "complete",
        data: {
          itemType: "fileChange",
          status: "completed",
          changes: [{ path: "a.ts", kind: "update", diff: "+fixed" }],
        },
      });

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
});
