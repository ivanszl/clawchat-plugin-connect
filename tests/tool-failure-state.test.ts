import { describe, expect, it } from "bun:test";
import { IndeterminateToolExecutionError } from "../src/agent/tool-executor";
import { toolFailureState } from "../src/service/connect-surface-modules";

describe("tool request failure settlement", () => {
  it("marks deterministic Liveware errors failed", () => {
    expect(toolFailureState(new Error("Liveware app was not found"))).toBe("failed");
    expect(toolFailureState(new Error("managed app cannot be changed"))).toBe("failed");
  });

  it("preserves indeterminate transport outcomes", () => {
    expect(toolFailureState(new IndeterminateToolExecutionError("outcome unknown"))).toBe("indeterminate");
  });
});
