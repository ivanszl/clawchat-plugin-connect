import { describe, expect, it, mock } from "bun:test";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { createReleasedRuntimeAdapterRegistry, releasedRuntimeAdapters } from "../src/runtime/released-adapters";
import type { ConnectRuntimeAdapter, ConnectRuntimeSession, RuntimeModelOption } from "../src/runtime/types";
import type { AgentBindingConfig, RuntimeWorkspace } from "../src/types";

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

  it("caches Skills per Binding workspace and invalidates them on native change notifications", async () => {
    let notifySkillsChanged: (() => void) | undefined;
    const unsubscribe = mock(() => undefined);
    const listSkills = mock(async () => [{ id: "skill-1", name: "grill-with-docs", description: "Review docs" }]);
    const codex = {
      ...adapter(),
      listSkills,
      onSkillsChanged: (listener: () => void) => {
        notifySkillsChanged = listener;
        return unsubscribe;
      },
    } satisfies ConnectRuntimeAdapter;
    const registry = new RuntimeAdapterRegistry([{ kind: "codex", create: () => codex }]);
    const binding = { kind: "codex", env: { CLAWCHAT_CONNECT_AGENT_ID: "work" } } as AgentBindingConfig;
    const workspace: RuntimeWorkspace = {
      projectId: "project-1",
      workingDirectory: "/repo",
      additionalDirectories: [],
      skipGitRepoCheck: true,
    };

    await expect(registry.listSkills(binding, workspace)).resolves.toEqual([
      { id: "skill-1", name: "grill-with-docs", description: "Review docs" },
    ]);
    await registry.listSkills(binding, workspace);
    expect(listSkills).toHaveBeenCalledTimes(1);

    notifySkillsChanged?.();
    await registry.listSkills(binding, workspace);
    expect(listSkills).toHaveBeenCalledTimes(2);

    await registry.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("caches Commands per Binding workspace and invalidates them on native change notifications", async () => {
    let notifyCommandsChanged: (() => void) | undefined;
    const unsubscribe = mock(() => undefined);
    const listCommands = mock(async () => [{ id: "command-1", name: "compact", description: "Compact the Session" }]);
    const opencode = {
      ...adapter("opencode"),
      listCommands,
      onCommandsChanged: (listener: () => void) => {
        notifyCommandsChanged = listener;
        return unsubscribe;
      },
    } satisfies ConnectRuntimeAdapter;
    const registry = new RuntimeAdapterRegistry([{ kind: "opencode", create: () => opencode }]);
    const binding = { kind: "opencode", env: { CLAWCHAT_CONNECT_AGENT_ID: "work" } } as AgentBindingConfig;
    const workspace: RuntimeWorkspace = {
      projectId: "project-1",
      workingDirectory: "/repo",
      additionalDirectories: [],
      skipGitRepoCheck: true,
    };

    await expect(registry.listCommands(binding, workspace)).resolves.toEqual([
      { id: "command-1", name: "compact", description: "Compact the Session" },
    ]);
    await registry.listCommands(binding, workspace);
    expect(listCommands).toHaveBeenCalledTimes(1);

    notifyCommandsChanged?.();
    await registry.listCommands(binding, workspace);
    expect(listCommands).toHaveBeenCalledTimes(2);

    await registry.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("caches model and Session option catalogs used by Turn Submission validation", async () => {
    const listModels = mock(
      async (): Promise<RuntimeModelOption[]> => [
        {
          id: "gpt-default",
          displayName: "Default model",
          description: "Runtime default",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          inputModalities: ["text"],
        },
      ],
    );
    const listSessionOptions = mock(async () => []);
    const codex = { ...adapter(), listModels, listSessionOptions } satisfies ConnectRuntimeAdapter;
    const registry = new RuntimeAdapterRegistry([{ kind: "codex", create: () => codex }]);
    const binding = { kind: "codex", env: { CLAWCHAT_CONNECT_AGENT_ID: "work" } } as AgentBindingConfig;
    const workspace: RuntimeWorkspace = {
      projectId: "project-1",
      workingDirectory: "/repo",
      additionalDirectories: [],
      skipGitRepoCheck: true,
    };

    await registry.listModels(binding);
    await registry.listModels(binding);
    await registry.listSessionOptions(binding, workspace);
    await registry.listSessionOptions(binding, workspace);

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listSessionOptions).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("does not start or indefinitely await Skill discovery while classifying a manual slash prefix", async () => {
    let finishDiscovery!: (skills: Array<{ id: string; name: string }>) => void;
    const pending = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      finishDiscovery = resolve;
    });
    const listSkills = mock(async () => await pending);
    const codex = { ...adapter(), listSkills } satisfies ConnectRuntimeAdapter;
    const registry = new RuntimeAdapterRegistry([{ kind: "codex", create: () => codex }]);
    const binding = { kind: "codex" } as AgentBindingConfig;
    const workspace: RuntimeWorkspace = {
      projectId: "project-1",
      workingDirectory: "/repo",
      additionalDirectories: [],
      skipGitRepoCheck: true,
    };

    await expect(registry.listSkills(binding, workspace, { existingOnly: true })).resolves.toBeNull();
    expect(listSkills).not.toHaveBeenCalled();

    const discovery = registry.listSkills(binding, workspace);
    await expect(registry.listSkills(binding, workspace, { existingOnly: true, waitMs: 1 })).resolves.toBeNull();
    expect(listSkills).toHaveBeenCalledTimes(1);
    finishDiscovery([{ id: "skill-1", name: "grill-with-docs" }]);
    await discovery;
    await registry.close();
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
      { kind: "workbuddy", displayName: "WorkBuddy" },
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
