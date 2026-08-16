import { describe, expect, it, mock } from "bun:test";
import type { RuntimeCapabilityRef } from "../src/plugin/sdk";
import { type RuntimeAdapterDefinition, RuntimeAdapterRegistry } from "../src/runtime/registry";
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

function runtime(pluginId: string, capabilityId = "runtime"): RuntimeCapabilityRef {
  return { pluginId, capabilityId };
}

function definition(
  exactRuntime: RuntimeCapabilityRef,
  create: () => ConnectRuntimeAdapter,
  family = "codex",
): RuntimeAdapterDefinition {
  return { runtime: exactRuntime, family, create };
}

function binding(exactRuntime: RuntimeCapabilityRef): AgentBindingConfig {
  return { runtime: exactRuntime, runtimeConfig: {} };
}

describe("RuntimeAdapterRegistry", () => {
  it("owns one Runtime Adapter instance and shutdown lifecycle per Agent Binding", async () => {
    const instances: ConnectRuntimeAdapter[] = [];
    const exactRuntime = runtime("test.codex");
    const registry = new RuntimeAdapterRegistry([
      definition(exactRuntime, () => {
        const instance = adapter();
        instances.push(instance);
        return instance;
      }),
    ]);
    const work = binding(exactRuntime);
    const review = binding(exactRuntime);

    registry.modesFor(work);
    registry.modesFor(review);
    registry.modesFor(work);
    expect(instances).toHaveLength(2);

    await registry.close();
    for (const instance of instances) expect(instance.close).toHaveBeenCalledTimes(1);
  });

  it("selects only the exact Plugin capability while deriving Runtime family from provider metadata", async () => {
    const first = adapter();
    const second = adapter();
    const firstRuntime = runtime("test.codex", "first");
    const secondRuntime = runtime("test.codex", "second");
    const registry = new RuntimeAdapterRegistry([
      definition(firstRuntime, () => first),
      definition(secondRuntime, () => second),
    ]);
    const selected = binding(secondRuntime);
    const context = {
      agentId: "work",
      chatId: "chat-1",
      sessionId: "session-1",
      runtimeSessionId: null,
      configPath: "/tmp/config.json",
      stateDbPath: "/tmp/state.sqlite",
      onRuntimeSessionId: async () => undefined,
    };

    expect(registry.familyFor(selected)).toBe("codex");
    await expect(registry.prepare(selected)).resolves.toBeUndefined();
    expect(first.prepare).not.toHaveBeenCalled();
    expect(second.prepare).toHaveBeenCalledWith(selected);
    await expect(registry.start(selected, context)).resolves.toBe(session);
    expect(second.start).toHaveBeenCalledWith(selected, context);
    expect(registry.modesFor(selected)).toEqual(["read-only", "workspace-write"]);
    await expect(registry.listModels(selected)).resolves.toBeNull();
    await expect(
      registry.discoverThreads(selected, {
        workspaceRef: "project-1",
        workingDirectory: "/repo",
        skipGitRepoCheck: true,
      }),
    ).resolves.toEqual([{ runtimeThreadId: "thread-1", name: "Existing thread", updatedAt: 1 }]);
  });

  it("allows capabilities with one Runtime family to coexist", () => {
    const stable = runtime("vendor.stable");
    const nightly = runtime("vendor.nightly");
    const registry = new RuntimeAdapterRegistry([
      definition(stable, () => adapter()),
      definition(nightly, () => adapter()),
    ]);

    expect(registry.familyFor(binding(stable))).toBe("codex");
    expect(registry.familyFor(binding(nightly))).toBe("codex");
  });

  it("rejects duplicate or missing exact capability providers with actionable identity", () => {
    const exactRuntime = runtime("test.codex");
    expect(
      () =>
        new RuntimeAdapterRegistry([
          definition(exactRuntime, () => adapter()),
          definition(exactRuntime, () => adapter()),
        ]),
    ).toThrow("duplicate Runtime capability provider: test.codex/runtime");

    const registry = new RuntimeAdapterRegistry();
    expect(() => registry.modesFor(binding(runtime("missing.plugin", "codex")))).toThrow(
      "Runtime Plugin capability missing.plugin/codex is not active",
    );
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
    const exactRuntime = runtime("test.codex");
    const registry = new RuntimeAdapterRegistry([definition(exactRuntime, () => codex)]);
    const selected = binding(exactRuntime);
    const workspace: RuntimeWorkspace = {
      workspaceRef: "project-1",
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
    };

    await expect(registry.listSkills(selected, workspace)).resolves.toEqual([
      { id: "skill-1", name: "grill-with-docs", description: "Review docs" },
    ]);
    await registry.listSkills(selected, workspace);
    expect(listSkills).toHaveBeenCalledTimes(1);

    notifySkillsChanged?.();
    await registry.listSkills(selected, workspace);
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
    const exactRuntime = runtime("test.opencode");
    const registry = new RuntimeAdapterRegistry([definition(exactRuntime, () => opencode, "opencode")]);
    const selected = binding(exactRuntime);
    const workspace: RuntimeWorkspace = {
      workspaceRef: "project-1",
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
    };

    await expect(registry.listCommands(selected, workspace)).resolves.toEqual([
      { id: "command-1", name: "compact", description: "Compact the Session" },
    ]);
    await registry.listCommands(selected, workspace);
    expect(listCommands).toHaveBeenCalledTimes(1);

    notifyCommandsChanged?.();
    await registry.listCommands(selected, workspace);
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
    const exactRuntime = runtime("test.codex");
    const registry = new RuntimeAdapterRegistry([definition(exactRuntime, () => codex)]);
    const selected = binding(exactRuntime);
    const workspace: RuntimeWorkspace = {
      workspaceRef: "project-1",
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
    };

    await registry.listModels(selected);
    await registry.listModels(selected);
    await registry.listSessionOptions(selected, workspace);
    await registry.listSessionOptions(selected, workspace);

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
    const exactRuntime = runtime("test.codex");
    const registry = new RuntimeAdapterRegistry([definition(exactRuntime, () => codex)]);
    const selected = binding(exactRuntime);
    const workspace: RuntimeWorkspace = {
      workspaceRef: "project-1",
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
    };

    await expect(registry.listSkills(selected, workspace, { existingOnly: true })).resolves.toBeNull();
    expect(listSkills).not.toHaveBeenCalled();

    const discovery = registry.listSkills(selected, workspace);
    await expect(registry.listSkills(selected, workspace, { existingOnly: true, waitMs: 1 })).resolves.toBeNull();
    expect(listSkills).toHaveBeenCalledTimes(1);
    finishDiscovery([{ id: "skill-1", name: "grill-with-docs" }]);
    await discovery;
    await registry.close();
  });
});
