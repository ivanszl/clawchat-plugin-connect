import { describe, expect, it, mock } from "bun:test";
import { defaultConfig } from "../src/config";
import { materializeRuntimeOutput, policyForOutputVisibility, resolveOutputVisibility } from "../src/output-visibility";
import type { ConnectStateStore } from "../src/state";

describe("output visibility", () => {
  it("uses a Binding-scoped chat override before the Binding default", async () => {
    const config = defaultConfig();
    config.outputVisibility = "minimal";
    config.agents.work = { kind: "codex", outputVisibility: "normal" };
    const store = { getOutputVisibility: mock(async () => "full") } as unknown as ConnectStateStore;
    await expect(resolveOutputVisibility({ config, store, bindingId: "work", chatId: "chat-1" })).resolves.toBe("full");
    expect(store.getOutputVisibility).toHaveBeenCalledWith("work", "chat-1");
  });
  it("falls back from the Binding default to the installation default", async () => {
    const config = defaultConfig();
    config.outputVisibility = "minimal";
    config.agents.work = { kind: "codex", outputVisibility: "full" };
    await expect(resolveOutputVisibility({ config, bindingId: "work", chatId: "chat-1" })).resolves.toBe("full");
    await expect(resolveOutputVisibility({ config, bindingId: "missing", chatId: "chat-1" })).resolves.toBe("minimal");
  });
  it("hides progress in normal mode and always materializes controls", () => {
    const policy = policyForOutputVisibility("normal");
    const base = { position: "0", parentId: null, state: "complete", source: "live" } as const;
    expect(materializeRuntimeOutput({ ...base, id: "progress", kind: "progress", text: "hidden" }, policy)).toBeNull();
    expect(
      materializeRuntimeOutput(
        {
          ...base,
          id: "control",
          kind: "error",
          text: "approve",
          data: { outputKind: "control", requiredControl: true },
        },
        policy,
      ),
    ).toEqual({
      text: "approve",
      requiredControl: true,
    });
  });
  it("projects recovered native activity without republishing it to a remote surface", () => {
    const policy = policyForOutputVisibility("full");
    expect(
      materializeRuntimeOutput(
        {
          id: "recovered-native-assistant",
          position: "1.2",
          parentId: null,
          kind: "assistant",
          text: "authored while Connect was disconnected",
          state: "complete",
          source: "history",
          data: { suppressRemoteDelivery: true },
        },
        policy,
      ),
    ).toBeNull();
  });
});
