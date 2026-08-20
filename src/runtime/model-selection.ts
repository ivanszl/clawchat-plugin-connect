import type { AgentBindingConfig, RuntimeModelSelection, RuntimeSessionRecord, SessionIntentRecord } from "../types";
import type { RuntimeModelOption } from "./types";

export interface EffectiveModelSelection {
  model?: RuntimeModelSelection;
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
      model: option.selection,
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
      model: option.selection,
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
        model: option.selection,
        reasoningEffort: resolveEffort(option, binding.modelReasoningEffort, false),
        source: bindingEffortIsValid ? "binding" : "runtime",
      }
    : { source: "runtime" };
}

export function requireModel(
  models: RuntimeModelOption[] | null,
  selection: RuntimeModelSelection | string,
): RuntimeModelOption {
  if (!models) throw new Error("This Runtime Adapter does not support model selection");
  const option =
    typeof selection === "string"
      ? models.find(
          (candidate) =>
            candidate.id.toLowerCase() === selection.trim().toLowerCase() ||
            runtimeModelSelectionLabel(candidate.selection).toLowerCase() === selection.trim().toLowerCase(),
        )
      : models.find((candidate) => runtimeModelSelectionsEqual(candidate.selection, selection));
  if (!option) {
    const label = typeof selection === "string" ? selection : runtimeModelSelectionLabel(selection);
    throw new Error(`Model is not available: ${label}`);
  }
  return option;
}

export function runtimeModelSelectionsEqual(
  left: RuntimeModelSelection | null | undefined,
  right: RuntimeModelSelection | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    (left.provider ?? "").toLowerCase() === (right.provider ?? "").toLowerCase() &&
    left.model.toLowerCase() === right.model.toLowerCase()
  );
}

export function runtimeModelSelectionLabel(selection: RuntimeModelSelection): string {
  return selection.provider ? `${selection.provider}/${selection.model}` : selection.model;
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
    `Reasoning effort \`${requested}\` is not supported by ${runtimeModelSelectionLabel(model.selection)}; choose ${model.supportedReasoningEfforts.join(", ")}`,
  );
}
