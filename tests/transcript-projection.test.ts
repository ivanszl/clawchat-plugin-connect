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
});
