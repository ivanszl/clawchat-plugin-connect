import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { generateSessionRef } from "../persistence/session-refs";
import type { ConnectStateStore } from "../persistence/state";
import type { RuntimeWorkspaceSnapshot } from "../runtime/types";
import type { RuntimeSessionRecord, RuntimeWorkspace, WorkspaceRecord } from "../types";
import { workspaceView } from "./workspace-catalog";

export interface WorkspaceCatalogOptions {
  workspaceRoot?: string;
  workspaceRefFactory?: () => string;
}

export class WorkspaceCatalog {
  readonly workspaceRoot: string;
  private readonly workspaceRefFactory: () => string;
  private catalogWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateStore: ConnectStateStore,
    options: WorkspaceCatalogOptions = {},
  ) {
    this.workspaceRoot = options.workspaceRoot ?? join(dirname(stateStore.dbPath), "workspaces");
    this.workspaceRefFactory = options.workspaceRefFactory ?? generateSessionRef;
    if (!isAbsolute(this.workspaceRoot)) throw new Error("workspace root must be an absolute path");
  }

  async ensureDefault(bindingId: string): Promise<WorkspaceRecord> {
    const normalizedBindingId = requireText(bindingId, "Agent Binding ID");
    return await this.serializeCatalogWrite(async () => {
      const existing = (await this.stateStore.listWorkspaces(normalizedBindingId)).find(
        (workspace) => workspace.source === "default",
      );
      if (existing) return workspaceViewRecord(existing);
      const rootPath = join(this.workspaceRoot, stablePathSegment(normalizedBindingId), "default");
      await mkdir(rootPath, { recursive: true, mode: 0o700 });
      return workspaceViewRecord(
        await this.stateStore.insertWorkspace({
          bindingId: normalizedBindingId,
          workspaceRef: this.workspaceRefFactory(),
          runtimeIdentityKey: null,
          source: "default",
          name: "Default",
          rootPath,
          selectable: true,
        }),
      );
    });
  }

  async add(bindingId: string, rootPath: string): Promise<WorkspaceRecord> {
    const normalizedBindingId = requireText(bindingId, "Agent Binding ID");
    const canonicalRoot = await existingDirectory(rootPath, "Workspace root");
    return await this.serializeCatalogWrite(async () => {
      const duplicate = (await this.stateStore.listWorkspaces(normalizedBindingId)).find(
        (workspace) => resolve(workspace.rootPath) === canonicalRoot,
      );
      if (duplicate) return workspaceViewRecord(duplicate);
      return workspaceViewRecord(
        await this.stateStore.insertWorkspace({
          bindingId: normalizedBindingId,
          workspaceRef: this.workspaceRefFactory(),
          runtimeIdentityKey: null,
          source: "runtime",
          name: requireWorkspaceView(canonicalRoot).name,
          rootPath: canonicalRoot,
          selectable: true,
        }),
      );
    });
  }

  async get(bindingId: string, reference: string): Promise<WorkspaceRecord | null> {
    const normalizedBindingId = requireText(bindingId, "Agent Binding ID");
    const value = reference.trim();
    if (!value) return null;
    return workspaceViewRecordOrNull(await this.stateStore.getWorkspace(normalizedBindingId, value));
  }

  async require(bindingId: string, reference: string): Promise<WorkspaceRecord> {
    const workspace = await this.get(bindingId, reference);
    if (!workspace?.selectable) {
      throw new Error(`unknown Workspace Ref for Agent Binding ${bindingId}: ${reference.trim() || "(empty)"}`);
    }
    return workspace;
  }

  async list(bindingId: string): Promise<WorkspaceRecord[]> {
    await this.ensureDefault(bindingId);
    return (await this.stateStore.listWorkspaces(bindingId))
      .map(workspaceViewRecord)
      .sort(
        (left, right) =>
          Number(right.source === "default") - Number(left.source === "default") || left.name.localeCompare(right.name),
      );
  }

  async listAll(): Promise<WorkspaceRecord[]> {
    return (await this.stateStore.listWorkspaces()).map(workspaceViewRecord);
  }

  async reconcile(
    bindingId: string,
    snapshot: RuntimeWorkspaceSnapshot,
  ): Promise<{ workspaces: WorkspaceRecord[]; failures: string[] }> {
    await this.ensureDefault(bindingId);
    const discovered = await Promise.allSettled(
      snapshot.identities
        .filter(
          (identity): identity is typeof identity & { localRoot: string } =>
            identity.kind === "persistent" && identity.localRoot !== null,
        )
        .map(async (identity) => ({
          runtimeIdentityKey: requireText(identity.key, "Runtime Workspace identity"),
          rootPath: await existingDirectory(identity.localRoot, "Runtime Workspace root"),
          name: requireWorkspaceView(identity.localRoot).name,
          workspaceRef: this.workspaceRefFactory(),
        })),
    );
    const failures = discovered.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    const identities = discovered.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    await this.stateStore.reconcileWorkspaceCatalog({
      bindingId: requireText(bindingId, "Agent Binding ID"),
      status: failures.length > 0 ? "partial" : snapshot.status,
      identities,
    });
    return { workspaces: await this.list(bindingId), failures };
  }

  async findForWorkspace(bindingId: string, rootPath: string): Promise<WorkspaceRecord | null> {
    const canonicalRoot = await existingDirectory(rootPath, "Runtime Workspace root");
    const candidates = (await this.list(bindingId)).filter((workspace) =>
      pathContains(resolve(workspace.rootPath), canonicalRoot),
    );
    return candidates.sort((left, right) => resolve(right.rootPath).length - resolve(left.rootPath).length)[0] ?? null;
  }

  async ensureDiscoveredWorkspace(
    bindingId: string,
    rootPath: string,
    runtimeIdentityKey = resolve(rootPath),
  ): Promise<WorkspaceRecord | null> {
    const canonicalRoot = await existingDirectory(rootPath, "Runtime Workspace root");
    const existing = await this.findForWorkspace(bindingId, canonicalRoot);
    if (existing) return existing;
    await this.reconcile(bindingId, {
      status: "partial",
      identities: [{ key: runtimeIdentityKey, kind: "persistent", localRoot: canonicalRoot }],
    });
    return await this.findForWorkspace(bindingId, canonicalRoot);
  }

  async resolveWorkspace(session: Pick<RuntimeSessionRecord, "agentId" | "workspaceRef">): Promise<RuntimeWorkspace> {
    const workspace = session.workspaceRef
      ? await this.get(session.agentId, session.workspaceRef)
      : await this.ensureDefault(session.agentId);
    if (!workspace) {
      throw new Error(
        `Workspace ${session.workspaceRef ?? "Default"} no longer exists for Agent Binding ${session.agentId}`,
      );
    }
    return {
      workspaceRef: workspace.workspaceRef,
      workingDirectory: workspace.rootPath,
      skipGitRepoCheck: true,
    };
  }

  async resolveWorkspaceRef(bindingId: string, workspaceRef: string): Promise<RuntimeWorkspace> {
    const workspace = await this.require(bindingId, workspaceRef);
    return { workspaceRef: workspace.workspaceRef, workingDirectory: workspace.rootPath, skipGitRepoCheck: true };
  }

  async remove(bindingId: string, workspaceRef: string): Promise<WorkspaceRecord> {
    return await this.serializeCatalogWrite(async () => {
      const workspace = await this.require(bindingId, workspaceRef);
      if (workspace.source === "default") throw new Error("Default Workspace cannot be removed");
      const sessions = await this.stateStore.countRuntimeSessionsForWorkspace(bindingId, workspace.workspaceRef);
      if (sessions > 0) throw new Error(`Workspace ${workspace.workspaceRef} is used by ${sessions} Session(s)`);
      await this.stateStore.deleteWorkspace(bindingId, workspace.workspaceRef);
      return workspace;
    });
  }

  async purgeBindingCatalog(bindingId: string): Promise<void> {
    await this.stateStore.deleteWorkspaceCatalog(bindingId);
  }

  private async serializeCatalogWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.catalogWrite.then(operation, operation);
    this.catalogWrite = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function workspaceViewRecord(workspace: WorkspaceRecord): WorkspaceRecord {
  if (workspace.source === "default") return workspace;
  const view = workspaceView(workspace.rootPath);
  return view ? { ...workspace, name: view.name } : workspace;
}

function workspaceViewRecordOrNull(workspace: WorkspaceRecord | null): WorkspaceRecord | null {
  return workspace ? workspaceViewRecord(workspace) : null;
}

function requireWorkspaceView(rootPath: string): { name: string } {
  const workspace = workspaceView(rootPath);
  if (!workspace) throw new Error(`Workspace root has no identity: ${rootPath}`);
  return workspace;
}

async function existingDirectory(value: string, label: string): Promise<string> {
  const path = value.trim();
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const canonical = await realpath(path).catch(() => {
    throw new Error(`${label} does not exist: ${path}`);
  });
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return canonical;
}

function pathContains(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function stablePathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
