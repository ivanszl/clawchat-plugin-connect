import { describe, expect, it, mock } from "bun:test";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimeAdapter, ConnectRuntimeSession } from "../src/runtime/types";
import type { AgentBindingConfig } from "../src/types";

const session: ConnectRuntimeSession = {
  prompt: async function* () {},
  close: async () => undefined,
};

function adapter(kind = "codex"): ConnectRuntimeAdapter {
  return {
    kind,
    modes: ["read-only", "workspace-write"],
    prepare: mock(async () => undefined),
    discoverThreads: mock(async () => [{ runtimeThreadId: "thread-1", name: "Existing thread", updatedAt: 1 }]),
    start: mock(async () => session),
    close: mock(async () => undefined),
  };
}

describe("RuntimeAdapterRegistry", () => {
  it("selects a Runtime Adapter from the Agent Binding kind", async () => {
    const codex = adapter();
    const registry = new RuntimeAdapterRegistry([codex]);
    const binding: AgentBindingConfig = { kind: "codex" };
    const context = {
      agentId: "work",
      chatId: "chat-1",
      sessionId: "session-1",
      runtimeSessionId: null,
      configPath: "/tmp/config.json",
      stateDbPath: "/tmp/state.sqlite",
      onRuntimeSessionId: async () => undefined,
    };

    await expect(registry.prepare(binding)).resolves.toBeUndefined();
    expect(codex.prepare).toHaveBeenCalledWith(binding);
    await expect(registry.start(binding, context)).resolves.toBe(session);
    expect(codex.start).toHaveBeenCalledWith(binding, context);
    expect(registry.modesFor(binding)).toEqual(["read-only", "workspace-write"]);
    await expect(
      registry.discoverThreads(binding, {
        projectId: "project-1",
        workingDirectory: "/repo",
        additionalDirectories: [],
        skipGitRepoCheck: true,
      }),
    ).resolves.toEqual([{ runtimeThreadId: "thread-1", name: "Existing thread", updatedAt: 1 }]);
    await registry.close();
    expect(codex.close).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate and unregistered Runtime Adapter kinds", async () => {
    expect(() => new RuntimeAdapterRegistry([adapter(), adapter()])).toThrow("duplicate Runtime Adapter kind: codex");
    const registry = new RuntimeAdapterRegistry([adapter()]);
    const unsupported = { kind: "claude" } as unknown as AgentBindingConfig;

    expect(() => registry.modesFor(unsupported)).toThrow("no Runtime Adapter registered for kind: claude");
  });
});
