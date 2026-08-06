import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { RuntimeActivity } from "../src/runtime/types";
import { fixedRuntimeAdapter } from "./runtime-adapter-fixture";

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
  it("projects inherited Subagent history only once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-subagent-deduplication-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-subagent-deduplication",
        sessionId: "session-subagent-deduplication",
        agentId: "codex",
        runtimeSessionId: "thread-subagent-deduplication",
        hasMessages: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-subagent-deduplication", "codex");
      if (!session) throw new Error("test Session was not created");
      const config = defaultConfig();
      config.agents = { codex: { kind: "codex" } };
      const inherited = {
        id: "shared-user-message",
        position: "0.1",
        parentId: null,
        kind: "user" as const,
        text: "original prompt",
        state: "complete" as const,
        source: "history" as const,
      };
      const runtimeAdapters = new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({
          kind: "codex",
          modes: [],
          readActivity: async () => ({
            completeness: "complete",
            limitations: [],
            activities: [
              inherited,
              {
                id: "subagent-one",
                position: "0.2",
                parentId: null,
                kind: "subagent",
                text: "Worker one",
                state: "complete",
                source: "history",
                children: [
                  { ...inherited, parentId: "subagent-one" },
                  {
                    id: "worker-one-result",
                    position: "0.2.1",
                    parentId: "subagent-one",
                    kind: "assistant",
                    text: "first result",
                    state: "complete",
                    source: "history",
                  },
                ],
              },
              {
                id: "subagent-two",
                position: "0.3",
                parentId: null,
                kind: "subagent",
                text: "Worker two",
                state: "complete",
                source: "history",
                children: [
                  { ...inherited, parentId: "subagent-two" },
                  {
                    id: "worker-one-result",
                    position: "0.3.1",
                    parentId: "subagent-two",
                    kind: "assistant",
                    text: "latest result",
                    state: "complete",
                    source: "history",
                  },
                ],
              },
            ],
          }),
          start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
        }),
      ]);

      await new TranscriptProjection({ stateStore: store, config, runtimeAdapters }).reconcile(session);

      const blocks = await store.listTranscriptBlocks(session.sessionRef);
      expect(blocks.filter((block) => block.plainText === "original prompt")).toHaveLength(1);
      expect(blocks.filter((block) => block.type === "subagent")).toMatchObject([
        { blocks: [{ plainText: "latest result" }] },
        { blocks: [] },
      ]);
    } finally {
      await store.close();
    }
  });

  it("bounds nested Subagent history with a visible omission marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-subagent-bounds-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-subagent-bounds",
        sessionId: "session-subagent-bounds",
        agentId: "codex",
        runtimeSessionId: "thread-subagent-bounds",
        hasMessages: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-subagent-bounds", "codex");
      if (!session) throw new Error("test Session was not created");
      const nested = (depth: number): RuntimeActivity => ({
        id: `nested-${depth}`,
        position: `0.${depth}`,
        parentId: depth === 0 ? "bounded-worker" : `nested-${depth - 1}`,
        kind: "subagent",
        text: `Nested worker ${depth}`,
        state: "complete",
        source: "history",
        children:
          depth === 8
            ? [
                {
                  id: "too-deep-result",
                  position: "0.9.1",
                  parentId: "nested-8",
                  kind: "assistant",
                  text: "must not be embedded",
                  state: "complete",
                  source: "history",
                },
              ]
            : [nested(depth + 1)],
      });
      const activity: RuntimeActivity = {
        id: "bounded-worker",
        position: "0.1",
        parentId: null,
        kind: "subagent",
        text: "Bounded worker",
        state: "complete",
        source: "history",
        data: { title: "oversized title ".repeat(100_000), role: "oversized role ".repeat(100_000) },
        children: [
          nested(0),
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `large-result-${index}`,
            position: `0.10.${index}`,
            parentId: "bounded-worker",
            kind: "assistant" as const,
            text: `result ${index} ${"x".repeat(20_000)}`,
            state: "complete" as const,
            source: "history" as const,
          })),
        ],
      };

      await new TranscriptProjection({
        stateStore: store,
        config: defaultConfig(),
        runtimeAdapters: new RuntimeAdapterRegistry([]),
      }).upsertRuntimeActivity(session.sessionRef, activity);

      const blocks = await store.listTranscriptBlocks(session.sessionRef);
      const block = blocks.find(
        (candidate) => candidate.type === "subagent" && candidate.plainText === "Bounded worker",
      );
      const serialized = JSON.stringify(block);
      expect(Buffer.byteLength(serialized)).toBeLessThan(512 * 1024);
      expect(serialized).toContain("Additional Sub-agent history was omitted");
      expect(serialized).not.toContain("must not be embedded");
      expect(blocks.filter((candidate) => candidate.plainText === "must not be embedded")).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("rekeys a ClawChat inbound block from authoritative turn context instead of duplicating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-clawchat-user-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-clawchat-user",
        sessionId: "session-clawchat-user",
        agentId: "codex",
        runtimeSessionId: "thread-clawchat-user",
        name: "ClawChat user reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-clawchat-user", "codex");
      if (!session) throw new Error("test Session was not created");
      const projection = new TranscriptProjection({
        stateStore: store,
        config: defaultConfig(),
        runtimeAdapters: new RuntimeAdapterRegistry([]),
      });
      await projection.appendUserMessage({
        sessionRef: session.sessionRef,
        text: "hello",
        origin: "clawchat",
        author: "Colin",
        id: "clawchat-message-1",
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "item-1",
        aliases: ["native-user-1"],
        position: "0.1",
        parentId: null,
        kind: "user",
        text: "<clawchat_turn_context>\n{}\n</clawchat_turn_context>\n\nhello",
        state: "complete",
        source: "history",
        data: { clawchatMessageId: "clawchat-message-1" },
      });

      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          id: expect.stringMatching(/^b_/u),
          origin: "clawchat",
          runtimeSource: "history",
          plainText: "hello",
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("reconciles a Web user message with its Runtime history item without losing media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-web-user-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-web-user",
        sessionId: "session-web-user",
        agentId: "codex",
        runtimeSessionId: "thread-web-user",
        name: "Web user reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-web-user", "codex");
      if (!session) throw new Error("test Session was not created");
      const projection = new TranscriptProjection({
        stateStore: store,
        config: defaultConfig(),
        runtimeAdapters: new RuntimeAdapterRegistry([]),
      });

      await projection.appendUserMessage({
        sessionRef: session.sessionRef,
        text: "small message",
        origin: "client",
        author: "You",
        id: "turn_submission-1_user",
        media: [
          {
            kind: "image",
            url: "/client/v1/media/submission-1/0",
            name: "image.png",
            mime: "image/png",
            width: null,
            height: null,
          },
        ],
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "runtime-user-item",
        position: "0.1",
        parentId: null,
        kind: "user",
        text: "small message",
        state: "complete",
        source: "history",
      });

      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          id: expect.stringMatching(/^b_/u),
          origin: "client",
          runtimeSource: "history",
          plainText: "small message",
          media: [{ kind: "image", url: "/client/v1/media/submission-1/0", name: "image.png" }],
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("keeps a Liveware user message single while its Runtime activity is live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-live-client-user-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-live-client-user",
        sessionId: "session-live-client-user",
        agentId: "open",
        runtimeSessionId: "thread-live-client-user",
        name: "Live Client user reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-live-client-user", "open");
      if (!session) throw new Error("test Session was not created");
      const projection = new TranscriptProjection({
        stateStore: store,
        config: defaultConfig(),
        runtimeAdapters: new RuntimeAdapterRegistry([]),
      });

      await projection.appendUserMessage({
        sessionRef: session.sessionRef,
        text: "which model are you",
        origin: "client",
        author: "You",
        id: "turn_live_user",
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "runtime-live-user",
        position: "0.1",
        parentId: null,
        kind: "user",
        text: "which model are you",
        state: "complete",
        source: "live",
      });

      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          id: expect.stringMatching(/^b_/u),
          origin: "client",
          runtimeSource: "live",
          plainText: "which model are you",
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("reconciles a selected Web Skill with Codex history that serializes the prefix as a dollar command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-web-skill-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-web-skill",
        sessionId: "session-web-skill",
        agentId: "codex",
        runtimeSessionId: "thread-web-skill",
        name: "Web Skill reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-web-skill", "codex");
      if (!session) throw new Error("test Session was not created");
      const projection = new TranscriptProjection({
        stateStore: store,
        config: defaultConfig(),
        runtimeAdapters: new RuntimeAdapterRegistry([]),
      });

      await projection.appendUserMessage({
        sessionRef: session.sessionRef,
        text: "/clawchat-browser-qa LIVEWARE-QA-FIRST-DONE",
        origin: "client",
        author: "You",
        id: "turn_skill_user",
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "runtime-skill-user",
        position: "0.1",
        parentId: null,
        kind: "user",
        text: "$clawchat-browser-qa LIVEWARE-QA-FIRST-DONE",
        state: "complete",
        source: "history",
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "runtime-skill-user",
        position: "0.1",
        parentId: null,
        kind: "user",
        text: "$clawchat-browser-qa LIVEWARE-QA-FIRST-DONE",
        state: "complete",
        source: "history",
      });

      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          id: expect.stringMatching(/^b_/u),
          origin: "client",
          runtimeSource: "history",
          plainText: "/clawchat-browser-qa LIVEWARE-QA-FIRST-DONE",
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("repairs stored Web and Runtime history duplicates during reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-stored-web-user-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-stored-web-user",
        sessionId: "session-stored-web-user",
        agentId: "codex",
        runtimeSessionId: "thread-stored-web-user",
        name: "Stored Web user reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-stored-web-user", "codex");
      if (!session) throw new Error("test Session was not created");
      await store.upsertTranscriptBlock(session.sessionRef, {
        id: "turn_submission-1_user",
        type: "message",
        origin: "client",
        state: "complete",
        plainText: "small message",
        role: "user",
        author: "You",
        markdown: "small message",
        media: [
          {
            kind: "image",
            url: "/client/v1/media/submission-1/0",
            name: "image.png",
            mime: "image/png",
            width: null,
            height: null,
          },
        ],
      });
      await store.upsertTranscriptBlock(session.sessionRef, {
        id: "b_runtime_user",
        type: "message",
        origin: "runtime",
        runtimeSource: "history",
        state: "complete",
        plainText: "small message",
        role: "user",
        author: "You",
        markdown: "small message",
      });
      const config = defaultConfig();
      config.agents = { codex: { kind: "codex" } };
      const projection = new TranscriptProjection({
        stateStore: store,
        config,
        runtimeAdapters: new RuntimeAdapterRegistry([
          fixedRuntimeAdapter({
            kind: "codex",
            modes: [],
            readActivity: async () => ({ activities: [], completeness: "complete", limitations: [] }),
            start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
          }),
        ]),
      });

      await projection.reconcile(session);

      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          id: "b_runtime_user",
          origin: "client",
          runtimeSource: "history",
          media: [{ kind: "image", url: "/client/v1/media/submission-1/0", name: "image.png" }],
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("repairs stored ClawChat and Runtime history duplicates during reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-stored-clawchat-user-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-stored-clawchat-user",
        sessionId: "session-stored-clawchat-user",
        agentId: "open",
        runtimeSessionId: "thread-stored-clawchat-user",
        name: "Stored ClawChat user reconciliation",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-stored-clawchat-user", "open");
      if (!session) throw new Error("test Session was not created");
      await store.upsertTranscriptBlock(session.sessionRef, {
        id: "clawchat-message-1",
        type: "message",
        origin: "clawchat",
        state: "complete",
        plainText: "hello from ClawChat",
        role: "user",
        author: "Colin",
        sender: { id: "user-1", displayName: "Colin" },
        markdown: "hello from ClawChat",
      });
      await store.upsertTranscriptBlock(session.sessionRef, {
        id: "b_runtime_user",
        type: "message",
        origin: "runtime",
        runtimeSource: "history",
        state: "complete",
        plainText: "hello from ClawChat",
        role: "user",
        author: "You",
        markdown: "hello from ClawChat",
      });
      const config = defaultConfig();
      config.agents = { open: { kind: "opencode" } };
      const projection = new TranscriptProjection({
        stateStore: store,
        config,
        runtimeAdapters: new RuntimeAdapterRegistry([
          fixedRuntimeAdapter({
            kind: "opencode",
            modes: [],
            readActivity: async () => ({ activities: [], completeness: "complete", limitations: [] }),
            start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
          }),
        ]),
      });

      await projection.reconcile(session);

      await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([
        {
          id: "b_runtime_user",
          origin: "clawchat",
          runtimeSource: "history",
          author: "Colin",
          sender: { id: "user-1", displayName: "Colin" },
        },
      ]);
    } finally {
      await store.close();
    }
  });

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

  it("relocates an unpositioned fallback block when a native position later claims its sequence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-sequence-collision-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-sequence-collision",
        sessionId: "session-sequence-collision",
        agentId: "codex",
        runtimeSessionId: "thread-sequence-collision",
        name: "Sequence collision",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-sequence-collision", "codex");
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
        source: "history",
      });

      await projection.upsertRuntimeActivity(session.sessionRef, positioned("native-eight", "0.8"));
      await projection.upsertRuntimeActivity(session.sessionRef, positioned("fallback", "rollout:1"));
      await projection.upsertRuntimeActivity(session.sessionRef, positioned("native-nine", "0.9"));

      const blocks = await store.listTranscriptBlocks(session.sessionRef);
      expect(blocks.map((block) => [block.plainText, block.sequence])).toEqual([
        ["native-eight", 1_000_008],
        ["native-nine", 1_000_009],
        ["fallback", 1_000_010],
      ]);
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
        fixedRuntimeAdapter({
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
        }),
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

  it("settles orphaned streaming blocks when Runtime history reports that turn interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-transcript-interrupted-turn-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await store.upsertRuntimeSession({
        chatId: "chat-interrupted",
        sessionId: "session-interrupted",
        agentId: "codex",
        runtimeSessionId: "thread-interrupted",
        name: "Interrupted turn",
        hasMessages: true,
        isCurrent: true,
      });
      const session = await store.getCurrentRuntimeSession("chat-interrupted", "codex");
      if (!session) throw new Error("test Session was not created");
      const config = defaultConfig();
      config.agents = { codex: { kind: "codex" } };
      const runtimeAdapters = new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({
          kind: "codex",
          modes: [],
          readActivity: async () => ({
            completeness: "partial",
            limitations: ["correlation"],
            activities: [
              {
                id: "turn:turn-interrupted",
                position: "0.0",
                parentId: null,
                kind: "turn",
                text: "Codex turn interrupted.",
                state: "cancelled",
                source: "history",
              },
              {
                id: "history-agent",
                aliases: ["live-agent"],
                position: "0.3",
                parentId: null,
                kind: "assistant",
                text: "working",
                state: "cancelled",
                source: "history",
              },
              {
                id: "fallback-command",
                aliases: ["live-command"],
                position: "0.4",
                parentId: null,
                kind: "command",
                text: "Codex running command: sleep 25",
                state: "streaming",
                source: "fallback",
                data: { command: "sleep 25", status: "running" },
              },
              {
                id: "fallback-subagent",
                aliases: ["live-subagent"],
                position: "0.5",
                parentId: null,
                kind: "subagent",
                text: "Worker",
                state: "complete",
                source: "fallback",
                data: { title: "Worker", activityKind: "started" },
                children: [
                  {
                    id: "fallback-subagent-command",
                    aliases: ["live-subagent-command"],
                    position: "0.5.1",
                    parentId: "fallback-subagent",
                    kind: "command",
                    text: "still running",
                    state: "streaming",
                    source: "fallback",
                    data: { command: "sleep 25", status: "running" },
                  },
                ],
              },
            ],
          }),
          start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
        }),
      ]);
      const projection = new TranscriptProjection({ stateStore: store, config, runtimeAdapters });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "turn:turn-interrupted",
        position: "0.0",
        parentId: null,
        kind: "progress",
        text: "Codex turn started.",
        state: "streaming",
        source: "live",
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "live-agent",
        position: "0.3",
        parentId: null,
        kind: "assistant",
        text: "working",
        state: "streaming",
        source: "live",
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "live-command",
        position: "0.4",
        parentId: null,
        kind: "command",
        text: "Codex running command: sleep 25",
        state: "streaming",
        source: "live",
        data: { command: "sleep 25", status: "running" },
      });
      await projection.upsertRuntimeActivity(session.sessionRef, {
        id: "live-subagent",
        position: "0.5",
        parentId: null,
        kind: "subagent",
        text: "Worker",
        state: "complete",
        source: "live",
        data: { title: "Worker", activityKind: "started" },
        children: [
          {
            id: "live-subagent-command",
            position: "0.5.1",
            parentId: "live-subagent",
            kind: "command",
            text: "still running",
            state: "streaming",
            source: "live",
            data: { command: "sleep 25", status: "running" },
          },
        ],
      });
      await projection.upsertRuntimeInteraction(session.sessionRef, {
        id: "runtime-interaction:approval-1",
        type: "runtime-interaction",
        origin: "runtime",
        state: "pending",
        plainText: "Approve command?",
        interactionId: "approval-1",
        interactionType: "approval",
        action: "command",
        title: "Approve command?",
        description: "Approval remains coordinator-owned.",
        responseState: "pending",
        options: [{ id: "deny", label: "Deny" }],
        questions: [],
        command: "sleep 25",
        cwd: null,
        files: [],
        autoResolutionAt: null,
        resolvedOptionId: null,
        resolvedBy: null,
      });

      await projection.reconcile(session);

      const blocks = await store.listTranscriptBlocks(session.sessionRef);
      expect(blocks.filter((block) => block.state === "streaming")).toEqual([]);
      expect(blocks.find((block) => block.type === "command")).toMatchObject({
        state: "cancelled",
        command: "sleep 25",
      });
      expect(blocks.find((block) => block.type === "progress")).toMatchObject({
        state: "cancelled",
        plainText: "Codex turn interrupted.",
      });
      expect(blocks.find((block) => block.type === "runtime-interaction")).toMatchObject({
        state: "pending",
        responseState: "pending",
      });
      expect(blocks.find((block) => block.type === "subagent")).toMatchObject({
        state: "complete",
        blocks: [{ type: "command", state: "cancelled", status: "cancelled" }],
      });
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
        fixedRuntimeAdapter({
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
        }),
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
        fixedRuntimeAdapter({
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
        }),
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
