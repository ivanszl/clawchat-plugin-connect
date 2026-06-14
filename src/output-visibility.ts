import type { ConnectConfig, OutputVisibility } from "./types.js";
import type { ConnectStateStore } from "./state.js";

export type RuntimeOutputKind = "final" | "assistant" | "tool" | "progress" | "reasoning" | "control";
export interface RuntimeOutputEvent { kind: RuntimeOutputKind; text: string; requiredControl?: boolean; }
export interface OutputVisibilityPolicy { mode: OutputVisibility; includeKinds: Set<RuntimeOutputKind>; }
export interface MaterializedRuntimeReply { text: string; requiredControl: boolean; }
export async function resolveOutputVisibility(params: { config: ConnectConfig; store?: ConnectStateStore; chatId: string }): Promise<OutputVisibility> { const override = await params.store?.getOutputVisibility(params.chatId).catch(() => null); return override ?? params.config.outputVisibility ?? "normal"; }
export function policyForOutputVisibility(mode: OutputVisibility): OutputVisibilityPolicy { if (mode === "minimal") return { mode, includeKinds: new Set(["final", "control"]) }; if (mode === "full") return { mode, includeKinds: new Set(["final", "assistant", "tool", "progress", "reasoning", "control"]) }; return { mode, includeKinds: new Set(["final", "assistant", "control"]) }; }
export function allowedRuntimeKinds(policy: OutputVisibilityPolicy): RuntimeOutputKind[] { return [...policy.includeKinds]; }
export function materializeRuntimeOutput(event: RuntimeOutputEvent, policy: OutputVisibilityPolicy): MaterializedRuntimeReply | null { if (!policy.includeKinds.has(event.kind)) return null; return { text: event.text, requiredControl: event.requiredControl === true || event.kind === "control" }; }
