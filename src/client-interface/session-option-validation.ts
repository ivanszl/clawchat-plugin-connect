import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { RuntimeSessionOption } from "../runtime/types";
import type { AgentBindingConfig, RuntimeWorkspace } from "../types";
import { commandError } from "./client-http";

export function validateSessionOptions(
  selected: Record<string, string>,
  definitions: RuntimeSessionOption[],
  requireInPlace = false,
): Record<string, string> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const [id, value] of Object.entries(selected)) {
    const definition = byId.get(id);
    if (!definition) throw new Error(`Session option is not available: ${id}`);
    if (requireInPlace && definition.changePolicy !== "in-place")
      throw new Error(`Session option requires a new Runtime Session: ${id}`);
    if (!definition.values.some((candidate) => candidate.id === value))
      throw new Error(`Session option value is not available: ${id}=${value}`);
  }
  return { ...selected };
}

export async function validatedSessionOptions(
  runtimeAdapters: RuntimeAdapterRegistry,
  binding: AgentBindingConfig,
  workspace: RuntimeWorkspace,
  selected: Record<string, string>,
  requireInPlace = false,
  scope?: import("../runtime/types").RuntimeCatalogScope,
): Promise<{ ok: true; value: Record<string, string> } | { ok: false; error: ReturnType<typeof commandError> }> {
  try {
    return {
      ok: true,
      value: validateSessionOptions(
        selected,
        await runtimeAdapters.listSessionOptions(binding, workspace, { ...scope, workspace }),
        requireInPlace,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: commandError(400, "invalid-session-options", error instanceof Error ? error.message : String(error)),
    };
  }
}
