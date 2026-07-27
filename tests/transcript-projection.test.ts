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
});
