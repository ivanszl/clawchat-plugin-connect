import { expect, it } from "bun:test";
import { SessionTurnExecutor } from "../src/runtime/session-turn-executor";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";
import type { TurnTarget } from "../src/workspaces/session-continuity";
import { pluginBinding } from "./runtime-adapter-fixture";

it("owns one native handle per Session and reports a new Runtime Thread through Session Continuity", async () => {
  const starts: string[] = [];
  const attachments: string[] = [];
  const closes: string[] = [];
  const adapter: ConnectRuntimeAdapter = {
    kind: "fake",
    modes: [],
    async start(_binding, context) {
      starts.push(context.sessionId);
      await context.onRuntimeSessionId("thread-created");
      return {
        async *prompt() {
          yield {
            id: "done",
            position: "0",
            parentId: null,
            kind: "assistant" as const,
            text: "done",
            state: "complete" as const,
            source: "live" as const,
            data: { outputKind: "final" },
          };
        },
        async close() {
          closes.push(context.sessionId);
        },
      };
    },
  };
  const target: TurnTarget = {
    chatId: "chat",
    bindingId: "agent",
    sessionId: "session",
    sessionRef: "ABCDEFGH",
    runtimeThreadId: null,
    workspaceRef: "WSDEFALT",
    name: null,
    mode: null,
    model: null,
    reasoningEffort: null,
    turnOrigin: "client",
  };
  const executor = new SessionTurnExecutor({
    configPath: "/tmp/config.json",
    stateDbPath: "/tmp/state.sqlite",
    bindingFor: () => pluginBinding({}, { displayName: "Fake" }),
    start: async (binding, context) => await adapter.start(binding, context),
    attachRuntimeThread: async (sessionRef, runtimeThreadId) => {
      attachments.push(`${sessionRef}:${runtimeThreadId}`);
    },
  });

  expect(
    await Array.fromAsync(
      executor.execute(target, {
        prompt: "first",
        workspace: {
          workspaceRef: "WSDEFALT",
          workingDirectory: "/tmp",
          skipGitRepoCheck: true,
        },
      }),
    ),
  ).toEqual([
    {
      id: "done",
      position: "0",
      parentId: null,
      kind: "assistant",
      text: "done",
      state: "complete",
      source: "live",
      data: { outputKind: "final" },
    },
  ]);
  await Array.fromAsync(
    executor.execute(target, {
      prompt: "second",
      workspace: {
        workspaceRef: "WSDEFALT",
        workingDirectory: "/tmp",
        skipGitRepoCheck: true,
      },
    }),
  );

  expect(starts).toEqual(["session"]);
  expect(attachments).toEqual(["ABCDEFGH:thread-created"]);
  await executor.release(target.sessionRef);
  expect(closes).toEqual(["session"]);
});
