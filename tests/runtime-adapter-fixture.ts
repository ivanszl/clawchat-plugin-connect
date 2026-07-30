import type { RuntimeAdapterDefinition } from "../src/runtime/registry";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";

export function fixedRuntimeAdapter(adapter: ConnectRuntimeAdapter): RuntimeAdapterDefinition {
  return { kind: adapter.kind, create: () => adapter };
}
