import { describe, expect, it } from "bun:test";
import { resolveModelSelection } from "../src/runtime/model-selection";
import type { RuntimeModelOption } from "../src/runtime/types";

const models: RuntimeModelOption[] = [
  {
    id: "gpt-default",
    displayName: "Default",
    description: "Runtime default",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-session",
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
        { kind: "codex", model: "gpt-default", modelReasoningEffort: "low" },
        { model: "gpt-session", reasoningEffort: "xhigh" },
        models,
      ),
    ).toEqual({ model: "gpt-session", reasoningEffort: "xhigh", source: "session" });
    expect(
      resolveModelSelection(
        { kind: "codex", model: "gpt-default", modelReasoningEffort: "low" },
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: "gpt-default", reasoningEffort: "low", source: "binding" });
    expect(resolveModelSelection({ kind: "codex" }, { model: null, reasoningEffort: null }, models)).toEqual({
      model: "gpt-default",
      reasoningEffort: "medium",
      source: "runtime",
    });
    expect(
      resolveModelSelection(
        { kind: "codex", modelReasoningEffort: "high" },
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: "gpt-default", reasoningEffort: "high", source: "binding" });
  });

  it("uses advertised defaults and rejects unavailable persisted Session choices", () => {
    expect(
      resolveModelSelection(
        { kind: "codex", model: "gpt-session", modelReasoningEffort: "minimal" },
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: "gpt-session", reasoningEffort: "high", source: "binding" });
    expect(
      resolveModelSelection(
        { kind: "codex", modelReasoningEffort: "minimal" },
        { model: null, reasoningEffort: null },
        models,
      ),
    ).toEqual({ model: "gpt-default", reasoningEffort: "medium", source: "runtime" });
    expect(() =>
      resolveModelSelection({ kind: "codex" }, { model: "gpt-removed", reasoningEffort: "high" }, models),
    ).toThrow("Model is not available: gpt-removed");
  });

  it("supports Runtime Adapters that do not advertise model discovery", () => {
    expect(resolveModelSelection({ kind: "codex" }, { model: null, reasoningEffort: null }, null)).toEqual({
      source: "runtime",
    });
  });
});
