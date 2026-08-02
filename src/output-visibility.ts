import type { RuntimeActivity } from "./runtime/types";
import type { ConnectStateStore } from "./state";
import type { ConnectConfig, OutputVisibility } from "./types";

export type RuntimeOutputKind = "final" | "assistant" | "tool" | "progress" | "reasoning" | "control";
export interface OutputVisibilityPolicy {
  mode: OutputVisibility;
  includeKinds: Set<RuntimeOutputKind>;
}
export interface MaterializedRuntimeReply {
  text: string;
  requiredControl: boolean;
}
export async function resolveOutputVisibility(params: {
  config: ConnectConfig;
  store?: ConnectStateStore;
  bindingId: string;
  chatId: string;
}): Promise<OutputVisibility> {
  const override = await params.store?.getOutputVisibility(params.bindingId, params.chatId).catch(() => null);
  return override ?? bindingOutputVisibility(params.config, params.bindingId);
}
export function bindingOutputVisibility(config: ConnectConfig, bindingId: string): OutputVisibility {
  return config.agents[bindingId]?.outputVisibility ?? config.outputVisibility ?? "normal";
}
export function policyForOutputVisibility(mode: OutputVisibility): OutputVisibilityPolicy {
  if (mode === "minimal") return { mode, includeKinds: new Set(["final", "control"]) };
  if (mode === "full")
    return { mode, includeKinds: new Set(["final", "assistant", "tool", "progress", "reasoning", "control"]) };
  return { mode, includeKinds: new Set(["final", "assistant", "control"]) };
}
export function allowedRuntimeKinds(policy: OutputVisibilityPolicy): RuntimeOutputKind[] {
  return [...policy.includeKinds];
}
export function materializeRuntimeOutput(
  activity: RuntimeActivity,
  policy: OutputVisibilityPolicy,
): MaterializedRuntimeReply | null {
  if (activity.data?.suppressRemoteDelivery === true) return null;
  const outputKind = runtimeOutputKind(activity);
  if (!policy.includeKinds.has(outputKind)) return null;
  return {
    text: activity.text,
    requiredControl: activity.data?.requiredControl === true || outputKind === "control",
  };
}

function runtimeOutputKind(activity: RuntimeActivity): RuntimeOutputKind {
  const declared = activity.data?.outputKind;
  if (
    declared === "final" ||
    declared === "assistant" ||
    declared === "tool" ||
    declared === "progress" ||
    declared === "reasoning" ||
    declared === "control"
  ) {
    return declared;
  }
  if (activity.kind === "assistant") return "assistant";
  if (activity.kind === "reasoning") return "reasoning";
  if (activity.kind === "command" || activity.kind === "file-change" || activity.kind === "tool") return "tool";
  if (activity.kind === "error") return "final";
  return "progress";
}
