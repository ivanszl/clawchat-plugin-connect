import type { AgentBindingConfig, RuntimeSessionRecord, SessionIntentRecord } from "../types";
import type { RuntimeModelOption } from "./types";

export interface EffectiveModelSelection {
  model?: string;
  reasoningEffort?: string;
  source: "session" | "binding" | "runtime";
}

export function resolveModelSelection(
  binding: AgentBindingConfig,
  selected: Pick<RuntimeSessionRecord | SessionIntentRecord, "model" | "reasoningEffort">,
  models: RuntimeModelOption[] | null,
): EffectiveModelSelection {
  if (selected.model) {
    const option = requireModel(models, selected.model);
    return {
      model: option.id,
      reasoningEffort: selected.reasoningEffort
        ? resolveEffort(option, selected.reasoningEffort, true)
        : resolveEffort(option, binding.modelReasoningEffort, false),
      source: "session",
    };
  }

  if (binding.model) {
    if (!models) {
      return {
        model: binding.model,
        ...(binding.modelReasoningEffort ? { reasoningEffort: binding.modelReasoningEffort } : {}),
        source: "binding",
      };
    }
    const option = requireModel(models, binding.model);
    return {
      model: option.id,
      reasoningEffort: resolveEffort(option, binding.modelReasoningEffort ?? null, false),
      source: "binding",
    };
  }

  const option = models?.find((candidate) => candidate.isDefault) ?? models?.[0];
  const bindingEffortIsValid = Boolean(
    binding.modelReasoningEffort && option?.supportedReasoningEfforts.includes(binding.modelReasoningEffort),
  );
  return option
    ? {
        model: option.id,
        reasoningEffort: resolveEffort(option, binding.modelReasoningEffort, false),
        source: bindingEffortIsValid ? "binding" : "runtime",
      }
    : { source: "runtime" };
}

export function requireModel(models: RuntimeModelOption[] | null, modelId: string): RuntimeModelOption {
  if (!models) throw new Error("This Runtime Adapter does not support model selection");
  const option = models.find((candidate) => candidate.id.toLowerCase() === modelId.trim().toLowerCase());
  if (!option) throw new Error(`Model is not available: ${modelId}`);
  return option;
}

export function resolveEffort(
  model: RuntimeModelOption,
  requested: string | null | undefined,
  rejectInvalid: boolean,
): string {
  if (!requested) return model.defaultReasoningEffort;
  if (model.supportedReasoningEfforts.includes(requested)) return requested;
  if (!rejectInvalid) return model.defaultReasoningEffort;
  throw new Error(
    `Reasoning effort \`${requested}\` is not supported by ${model.id}; choose ${model.supportedReasoningEfforts.join(", ")}`,
  );
}
