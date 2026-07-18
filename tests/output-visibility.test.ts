import { describe, expect, it, mock } from "bun:test";
import { defaultConfig } from "../src/config";
import { materializeRuntimeOutput, policyForOutputVisibility, resolveOutputVisibility } from "../src/output-visibility";
import type { ConnectStateStore } from "../src/state";

describe("output visibility", () => {
  it("uses chat override before global default", async () => {
    const config = defaultConfig();
    config.outputVisibility = "minimal";
    const store = { getOutputVisibility: mock(async () => "full") } as unknown as ConnectStateStore;
    await expect(resolveOutputVisibility({ config, store, chatId: "chat-1" })).resolves.toBe("full");
  });
  it("falls back to global config without project override", async () => {
    const config = defaultConfig();
    config.outputVisibility = "normal";
    await expect(resolveOutputVisibility({ config, chatId: "chat-1" })).resolves.toBe("normal");
  });
  it("hides progress in normal mode and always materializes controls", () => {
    const policy = policyForOutputVisibility("normal");
    expect(materializeRuntimeOutput({ kind: "progress", text: "hidden" }, policy)).toBeNull();
    expect(materializeRuntimeOutput({ kind: "control", text: "approve", requiredControl: true }, policy)).toEqual({
      text: "approve",
      requiredControl: true,
    });
  });
});
