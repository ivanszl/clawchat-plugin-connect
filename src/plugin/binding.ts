import type { AgentBindingConfig, OutputVisibility } from "../types";
import type { RuntimeCapabilityRef } from "./sdk";

const BINDING_FIELDS: Readonly<Record<string, true>> = {
  runtime: true,
  runtimeConfig: true,
  outputVisibility: true,
  displayName: true,
  sessionOptions: true,
  model: true,
  modelReasoningEffort: true,
};

const BINDING_IDENTITIES = new WeakMap<AgentBindingConfig, string>();

export function identifyAgentBinding(binding: AgentBindingConfig, agentId: string): AgentBindingConfig {
  BINDING_IDENTITIES.set(binding, agentId);
  return binding;
}

export function agentBindingIdentity(binding: AgentBindingConfig): string | undefined {
  return BINDING_IDENTITIES.get(binding);
}

export function createAgentBinding(options: {
  pluginId: string;
  capabilityId: string;
  configuration?: Record<string, unknown>;
}): AgentBindingConfig {
  return normalizeAgentBinding("CLI", {
    runtime: { pluginId: options.pluginId, capabilityId: options.capabilityId },
    runtimeConfig: options.configuration ?? {},
  });
}

export function normalizeAgentBinding(agentId: string, raw: unknown): AgentBindingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Agent Binding ${agentId} configuration must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((field) => !(field in BINDING_FIELDS));
  if (unsupported.length > 0) {
    throw new Error(`Agent Binding ${agentId} contains unsupported field: ${unsupported.join(", ")}`);
  }
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
  if (!("runtimeConfig" in record)) {
    throw new Error(`Agent Binding ${agentId} Runtime capability configuration is required`);
  }
  const runtimeConfig = record.runtimeConfig;
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    throw new Error(`Agent Binding ${agentId} Runtime capability configuration must be an object`);
  }

  const displayName = optionalString(record.displayName);
  const model = optionalString(record.model);
  const modelReasoningEffort = optionalString(record.modelReasoningEffort);
  const outputVisibility = optionalOutputVisibility(record.outputVisibility, agentId);
  const sessionOptions = optionalStringConfiguration(record.sessionOptions, agentId, "Session option");

  return {
    runtime,
    runtimeConfig: structuredClone(runtimeConfig as Record<string, unknown>),
    ...(displayName ? { displayName } : {}),
    ...(model ? { model } : {}),
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    ...(outputVisibility ? { outputVisibility } : {}),
    ...(sessionOptions ? { sessionOptions } : {}),
  };
}

function stableIdentity(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9._@/-]*[a-z0-9])?$/u.test(text)) {
    throw new Error(`${label} must be a stable lowercase identifier`);
  }
  return text;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("Agent Binding string preferences must be non-empty strings");
  return text;
}

function optionalOutputVisibility(value: unknown, agentId: string): OutputVisibility | undefined {
  if (value === undefined) return undefined;
  if (value !== "minimal" && value !== "normal" && value !== "full") {
    throw new Error(`Agent Binding ${agentId} outputVisibility must be minimal, normal, or full`);
  }
  return value;
}

function optionalStringConfiguration(
  value: unknown,
  agentId: string,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent Binding ${agentId} ${label} configuration must be an object`);
  }
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    const text = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!key || !text) {
      throw new Error(`Agent Binding ${agentId} ${label} keys and values must be non-empty strings`);
    }
    normalized[key] = text;
  }
  return normalized;
}
