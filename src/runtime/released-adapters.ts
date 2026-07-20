import { createCodexRuntimeAdapter } from "./codex-adapter";
import { RuntimeAdapterRegistry } from "./registry";

export function createReleasedRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  return new RuntimeAdapterRegistry([createCodexRuntimeAdapter()]);
}
