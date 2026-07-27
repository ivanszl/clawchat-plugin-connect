import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillCodexRolloutTranscript } from "../src/runtime/codex-rollout";

describe("Codex rollout transcript fallback", () => {
  it("inserts missing raw tool calls between app-server message anchors", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "connect-codex-rollout-"));
    const sessions = join(codexHome, "sessions", "2026", "07", "27");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-2026-07-27T11-02-16-thread-1.jsonl"),
      [
        record({ type: "message", id: "user-1", role: "user", content: [] }),
        record({
          type: "custom_tool_call",
          id: "tool-native-1",
          call_id: "call-1",
          name: "exec",
          input: "await tools.exec_command({ cmd: 'bun test' })",
          status: "completed",
          internal_chat_message_metadata_passthrough: {
            secret: "must-not-leak",
          },
        }),
        record({
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: [
            { type: "input_text", text: "24 pass" },
            { type: "input_text", text: "exit 0" },
          ],
        }),
        record({
          type: "message",
          id: "agent-1",
          role: "assistant",
          content: [],
        }),
      ].join("\n"),
    );

    const snapshot = await backfillCodexRolloutTranscript({
      codexHome,
      runtimeThreadId: "thread-1",
      appServerEntries: [
        {
          id: "user-1",
          kind: "user",
          text: "run the tests",
          state: "complete",
          source: "history",
        },
        {
          id: "agent-1",
          kind: "assistant",
          text: "done",
          state: "complete",
          source: "history",
        },
      ],
    });

    expect(snapshot.completeness).toBe("complete");
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["user-1", "rollout:call-1", "agent-1"]);
    expect(snapshot.entries[1]).toMatchObject({
      kind: "tool",
      state: "complete",
      source: "fallback",
      data: {
        itemType: "rawToolCall",
        tool: "exec",
        nativeCallId: "call-1",
        input: "await tools.exec_command({ cmd: 'bun test' })",
        output: "24 pass\nexit 0",
      },
    });
    expect(JSON.stringify(snapshot.entries[1])).not.toContain("must-not-leak");
  });

  it("keeps app-server history and reports partial completeness when no rollout is available", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "connect-codex-rollout-missing-"));
    const appServerEntries = [
      {
        id: "agent-1",
        kind: "assistant" as const,
        text: "available history",
        state: "complete" as const,
        source: "history" as const,
      },
    ];

    await expect(
      backfillCodexRolloutTranscript({
        codexHome,
        runtimeThreadId: "missing-thread",
        appServerEntries,
      }),
    ).resolves.toEqual({ entries: appServerEntries, completeness: "partial" });
  });

  it("does not duplicate a rollout call already represented by an adapter entry", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "connect-codex-rollout-dedupe-"));
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-thread-1.jsonl"),
      [
        record({
          type: "function_call",
          id: "tool-native-1",
          call_id: "call-1",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "bun test" }),
          status: "completed",
        }),
        record({
          type: "function_call_output",
          call_id: "call-1",
          output: "ok",
        }),
      ].join("\n"),
    );
    const appServerEntries = [
      {
        id: "command-1",
        kind: "command" as const,
        text: "ok",
        state: "complete" as const,
        source: "history" as const,
        data: { nativeCallId: "call-1", command: "bun test" },
      },
    ];

    const snapshot = await backfillCodexRolloutTranscript({
      codexHome,
      runtimeThreadId: "thread-1",
      appServerEntries,
    });

    expect(snapshot.entries).toEqual(appServerEntries);
    expect(snapshot.completeness).toBe("complete");
  });

  it("does not duplicate a raw exec command already canonicalized by app-server", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "connect-codex-rollout-command-dedupe-"));
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-thread-1.jsonl"),
      [
        record({
          type: "function_call",
          id: "tool-native-1",
          call_id: "call-1",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "bun test" }),
          status: "completed",
        }),
        record({
          type: "function_call_output",
          call_id: "call-1",
          output: "ok",
        }),
      ].join("\n"),
    );
    const appServerEntries = [
      {
        id: "command-1",
        kind: "command" as const,
        text: "ok",
        state: "complete" as const,
        source: "history" as const,
        data: { command: "bun test" },
      },
    ];

    const snapshot = await backfillCodexRolloutTranscript({
      codexHome,
      runtimeThreadId: "thread-1",
      appServerEntries,
    });

    expect(snapshot.entries).toEqual(appServerEntries);
  });

  it("keeps non-text array output and skips apply_patch calls canonicalized as file changes", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "connect-codex-rollout-array-output-"));
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-thread-1.jsonl"),
      [
        record({
          type: "custom_tool_call",
          call_id: "patch-1",
          name: "apply_patch",
          input: "*** Begin Patch",
          status: "completed",
        }),
        record({
          type: "custom_tool_call_output",
          call_id: "patch-1",
          output: "Done!",
        }),
        record({
          type: "function_call",
          call_id: "call-1",
          name: "structured_tool",
          arguments: "{}",
          status: "completed",
        }),
        record({
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "json", value: { passed: true } }],
        }),
      ].join("\n"),
    );

    const snapshot = await backfillCodexRolloutTranscript({
      codexHome,
      runtimeThreadId: "thread-1",
      appServerEntries: [],
    });

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.data).toMatchObject({
      tool: "structured_tool",
      output: expect.stringContaining('"passed": true'),
    });
    expect(snapshot.entries.some((entry) => entry.data?.tool === "apply_patch")).toBe(false);
  });
});

function record(payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-07-27T03:00:00.000Z",
    type: "response_item",
    payload,
  });
}
