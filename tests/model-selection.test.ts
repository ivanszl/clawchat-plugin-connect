import { describe, expect, it } from "bun:test";
import { resolveModelSelection } from "../src/runtime/model-selection";
import type { RuntimeModelOption } from "../src/runtime/types";
import { pluginBinding } from "./runtime-adapter-fixture";

const models: RuntimeModelOption[] = [
  {
    id: "gpt-default",
    selection: { model: "gpt-default" },
    displayName: "Default",
    description: "Runtime default",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-session",
    selection: { model: "gpt-session" },
    displayName: "Session",
    description: "Session override",
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["high", "xhigh"],
    inputModalities: ["text"],
  },
];

describe("effective Runtime model selection", () => {
  it("resolves Session, Agent Binding, and Runtime defaults in precedence order", () => {
    expect(
      resolveModelSelection(
        pluginBinding({}, { model: { model: "gpt-default" }, modelReasoningEffort: "low" }),
        { model: { model: "gpt-session" }, reasoningEffort: "xhigh" },
        models,
      ),
    ).toEqual({ model: { model: "gpt-session" }, reasoningEffort: "xhigh", source: "session" });
    expect(
      resolveModelSelection(
        pluginBinding({}, { model: { model: "gpt-default" }, modelReasoningEffort: "low" }),
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: { model: "gpt-default" }, reasoningEffort: "low", source: "binding" });
    expect(resolveModelSelection(pluginBinding(), { model: null, reasoningEffort: null }, models)).toEqual({
      model: { model: "gpt-default" },
      reasoningEffort: "medium",
      source: "runtime",
    });
    expect(
      resolveModelSelection(
        pluginBinding({}, { modelReasoningEffort: "high" }),
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: { model: "gpt-default" }, reasoningEffort: "high", source: "binding" });
  });

  it("uses advertised defaults and rejects unavailable persisted Session choices", () => {
    expect(
      resolveModelSelection(
        pluginBinding({}, { model: { model: "gpt-session" }, modelReasoningEffort: "minimal" }),
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: { model: "gpt-session" }, reasoningEffort: "high", source: "binding" });
    expect(
      resolveModelSelection(
        pluginBinding({}, { modelReasoningEffort: "minimal" }),
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: { model: "gpt-default" }, reasoningEffort: "medium", source: "runtime" });
    expect(() =>
      resolveModelSelection(pluginBinding(), { model: { model: "gpt-removed" }, reasoningEffort: "high" }, models),
    ).toThrow("Model is not available: gpt-removed");
  });

  it("supports Runtime Adapters that do not advertise model discovery", () => {
    expect(resolveModelSelection(pluginBinding(), { model: null, reasoningEffort: null }, null)).toEqual({
      source: "runtime",
    });
  });
});
