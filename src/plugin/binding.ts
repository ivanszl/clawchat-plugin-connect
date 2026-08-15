import type { PluginAgentBindingConfig } from "../types";
import type { RuntimeCapabilityRef } from "./sdk";

export function createPluginAgentBinding(options: {
  runtimeFamily: string;
  pluginId: string;
  capabilityId: string;
  configuration?: Record<string, unknown>;
}): PluginAgentBindingConfig {
  return normalizePluginAgentBinding("CLI", {
    kind: "plugin",
    runtimeFamily: options.runtimeFamily,
    runtime: { pluginId: options.pluginId, capabilityId: options.capabilityId },
    runtimeConfig: options.configuration ?? {},
  });
}

export function normalizePluginAgentBinding(agentId: string, raw: unknown): PluginAgentBindingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Agent Binding ${agentId} Plugin configuration must be an object`);
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== "plugin") throw new Error(`Agent Binding ${agentId} is not a Plugin Binding`);
  const runtimeFamily = stableIdentity(record.runtimeFamily, `Agent Binding ${agentId} Runtime family`);
  if (!record.runtime || typeof record.runtime !== "object" || Array.isArray(record.runtime)) {
    throw new Error(`Agent Binding ${agentId} Runtime capability reference is required`);
  }
  const rawReference = record.runtime as Record<string, unknown>;
  const runtime: RuntimeCapabilityRef = {
    pluginId: stableIdentity(rawReference.pluginId, `Agent Binding ${agentId} Plugin ID`),
    capabilityId: stableIdentity(rawReference.capabilityId, `Agent Binding ${agentId} capability ID`),
  };
  if (Object.keys(rawReference).some((key) => key !== "pluginId" && key !== "capabilityId")) {
    throw new Error(
      `Agent Binding ${agentId} Runtime capability reference must contain only pluginId and capabilityId`,
    );
  }
  const runtimeConfig = record.runtimeConfig ?? {};
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    throw new Error(`Agent Binding ${agentId} Runtime capability configuration must be an object`);
  }
  return {
    kind: "plugin",
    runtimeFamily,
    runtime,
    runtimeConfig: structuredClone(runtimeConfig as Record<string, unknown>),
    ...(typeof record.displayName === "string" && record.displayName.trim()
      ? { displayName: record.displayName.trim() }
      : {}),
    ...(typeof record.outputVisibility === "string" &&
    (record.outputVisibility === "minimal" ||
      record.outputVisibility === "normal" ||
      record.outputVisibility === "full")
      ? { outputVisibility: record.outputVisibility }
      : {}),
    ...(typeof record.model === "string" && record.model.trim() ? { model: record.model.trim() } : {}),
    ...(typeof record.modelReasoningEffort === "string" && record.modelReasoningEffort.trim()
      ? { modelReasoningEffort: record.modelReasoningEffort.trim() }
      : {}),
    ...(record.sessionOptions && typeof record.sessionOptions === "object" && !Array.isArray(record.sessionOptions)
      ? { sessionOptions: stringConfiguration(record.sessionOptions as Record<string, unknown>, agentId) }
      : {}),
  };
}

function stableIdentity(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9._@/-]*[a-z0-9])?$/u.test(text)) {
    throw new Error(`${label} must be a stable lowercase identifier`);
  }
  return text;
}

function stringConfiguration(value: Record<string, unknown>, agentId: string): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    const text = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!key || !text)
      throw new Error(`Agent Binding ${agentId} Session option keys and values must be non-empty strings`);
    normalized[key] = text;
  }
  return normalized;
}
