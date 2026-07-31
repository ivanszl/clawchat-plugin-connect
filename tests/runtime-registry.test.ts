import { describe, expect, it, mock } from "bun:test";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { createReleasedRuntimeAdapterRegistry, releasedRuntimeAdapters } from "../src/runtime/released-adapters";
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
  it("owns one Runtime Adapter instance and shutdown lifecycle per Agent Binding", async () => {
    const instances: ConnectRuntimeAdapter[] = [];
    const registry = new RuntimeAdapterRegistry([
      {
        kind: "codex",
        create: () => {
          const instance = adapter();
          instances.push(instance);
          return instance;
        },
      },
    ]);
    const work = { kind: "codex", env: { CLAWCHAT_CONNECT_AGENT_ID: "work" } } as AgentBindingConfig;
    const review = { kind: "codex", env: { CLAWCHAT_CONNECT_AGENT_ID: "review" } } as AgentBindingConfig;

    registry.modesFor(work);
    registry.modesFor(review);
    registry.modesFor(work);
    expect(instances).toHaveLength(2);

    await registry.close();
    expect(instances.every((instance) => (instance.close as ReturnType<typeof mock>).mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("selects a Runtime Adapter from the Agent Binding kind", async () => {
    const codex = adapter();
    const registry = new RuntimeAdapterRegistry([{ kind: codex.kind, create: () => codex }]);
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
    await expect(registry.listModels(binding)).resolves.toBeNull();
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
    expect(
      () =>
        new RuntimeAdapterRegistry([
          { kind: "codex", create: () => adapter() },
          { kind: "codex", create: () => adapter() },
        ]),
    ).toThrow("duplicate Runtime Adapter kind: codex");
    const registry = new RuntimeAdapterRegistry([{ kind: "codex", create: () => adapter() }]);
    const unsupported = { kind: "claude" } as unknown as AgentBindingConfig;

    expect(() => registry.modesFor(unsupported)).toThrow("no Runtime Adapter registered for kind: claude");
  });

  it("constructs released adapters and operator metadata from one catalog", () => {
    expect(releasedRuntimeAdapters()).toEqual([
      { kind: "codex", displayName: "Codex" },
      { kind: "opencode", displayName: "OpenCode" },
    ]);
    expect(createReleasedRuntimeAdapterRegistry().modesFor({ kind: "codex" })).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(createReleasedRuntimeAdapterRegistry().lifecycleCapabilities({ kind: "opencode" })).toEqual({
      archive: false,
      restore: false,
      delete: true,
    });
  });
});
