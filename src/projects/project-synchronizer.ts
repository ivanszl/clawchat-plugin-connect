import { resolve } from "node:path";
import type { ConnectStateStore } from "../persistence/state";
import type { RuntimeThreadSummary } from "../runtime/types";
import type { ProjectRecord } from "../types";
import type { ProjectCatalog } from "./projects";

export interface RuntimeProjectSynchronizationResult {
  projects: ProjectRecord[];
  failures: string[];
}

export async function synchronizeRuntimeProjects(input: {
  bindingId: string;
  runtimeKind: string;
  threads: RuntimeThreadSummary[];
  projects: ProjectCatalog;
  stateStore: ConnectStateStore;
}): Promise<RuntimeProjectSynchronizationResult> {
  const failures: string[] = [];
  const seenIdentities = new Set<string>();
  for (const thread of input.threads) {
    if (thread.parentRuntimeThreadId || thread.isArchived) continue;
    const identity = thread.workspaceIdentity ?? {
      key: thread.workingDirectory ? resolve(thread.workingDirectory) : `thread:${thread.runtimeThreadId}`,
      kind: thread.workspaceKind ?? ("persistent" as const),
      localRoot: thread.workingDirectory ?? null,
    };
    if (identity.kind !== "persistent" || !identity.localRoot || seenIdentities.has(identity.key)) continue;
    seenIdentities.add(identity.key);
    try {
      const project =
        (await input.projects.findForWorkspace(identity.localRoot)) ??
        (await input.projects.ensureDiscoveredWorkspace(identity.localRoot));
      if (!project) continue;
      await input.stateStore.mapRuntimeWorkspaceIdentity({
        bindingId: input.bindingId,
        runtimeKind: input.runtimeKind,
        identityKey: identity.key,
        projectId: project.projectId,
      });
    } catch (error) {
      failures.push(`${identity.localRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { projects: await input.projects.list(), failures };
}
