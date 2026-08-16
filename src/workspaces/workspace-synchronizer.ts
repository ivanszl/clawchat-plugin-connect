import type { RuntimeWorkspaceSnapshot } from "../runtime/types";
import type { WorkspaceRecord } from "../types";
import type { WorkspaceCatalog } from "./workspaces";

export interface RuntimeWorkspaceSynchronizationResult {
  workspaces: WorkspaceRecord[];
  failures: string[];
}

export async function synchronizeRuntimeWorkspaces(input: {
  bindingId: string;
  snapshot: RuntimeWorkspaceSnapshot;
  workspaces: WorkspaceCatalog;
}): Promise<RuntimeWorkspaceSynchronizationResult> {
  try {
    return {
      workspaces: await input.workspaces.reconcile(input.bindingId, input.snapshot),
      failures: [],
    };
  } catch (error) {
    return {
      workspaces: await input.workspaces.list(input.bindingId),
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
}
