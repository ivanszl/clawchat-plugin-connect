import type { RuntimeCapabilityRef } from "../src/plugin/sdk";
import type { RuntimeAdapterDefinition } from "../src/runtime/registry";
import type { ConnectRuntimeAdapter } from "../src/runtime/types";
import type { AgentBindingConfig } from "../src/types";

export const TEST_RUNTIME_CAPABILITY = Object.freeze({
  pluginId: "test.runtime",
  capabilityId: "runtime",
}) satisfies RuntimeCapabilityRef;

export function pluginBinding(
  configuration: Record<string, unknown> = {},
  options: Pick<AgentBindingConfig, "displayName" | "outputVisibility" | "model" | "modelReasoningEffort"> = {},
): AgentBindingConfig {
  return {
    runtime: TEST_RUNTIME_CAPABILITY,
    runtimeConfig: structuredClone(configuration),
    ...options,
  };
}

export function fixedRuntimeAdapter(adapter: ConnectRuntimeAdapter): RuntimeAdapterDefinition {
  return {
    family: adapter.kind,
    runtime: TEST_RUNTIME_CAPABILITY,
    create: () => adapter,
  };
}
