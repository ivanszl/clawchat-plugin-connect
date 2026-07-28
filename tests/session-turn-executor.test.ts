import { expect, it } from "bun:test";
import type { RuntimeOutputEvent } from "../src/output-visibility";
import { SessionTurnExecutor } from "../src/runtime/session-turn-executor";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";
import type { TurnTarget } from "../src/session-continuity";

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
        async *prompt(): AsyncIterable<RuntimeOutputEvent> {
          yield { kind: "final", text: "done" };
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
    projectId: null,
    name: null,
    mode: null,
    model: null,
    reasoningEffort: null,
    turnOrigin: "client",
  };
  const executor = new SessionTurnExecutor({
    configPath: "/tmp/config.json",
    stateDbPath: "/tmp/state.sqlite",
    bindingFor: () => ({ kind: "codex", displayName: "Fake" }),
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
          projectId: null,
          workingDirectory: "/tmp",
          additionalDirectories: [],
          skipGitRepoCheck: true,
        },
      }),
    ),
  ).toEqual([{ kind: "final", text: "done" }]);
  await Array.fromAsync(
    executor.execute(target, {
      prompt: "second",
      workspace: {
        projectId: null,
        workingDirectory: "/tmp",
        additionalDirectories: [],
        skipGitRepoCheck: true,
      },
    }),
  );

  expect(starts).toEqual(["session"]);
  expect(attachments).toEqual(["ABCDEFGH:thread-created"]);
  await executor.release(target.sessionRef);
  expect(closes).toEqual(["session"]);
});
