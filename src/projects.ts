import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ConnectStateStore } from "./state";
import type { ProjectRecord, RuntimeSessionRecord, RuntimeWorkspace } from "./types";
import { findProjectForWorkspace, workspaceView } from "./workspace-catalog";

export interface ProjectCatalogOptions {
  workspaceRoot?: string;
}

export interface RemoveProjectResult {
  removed: boolean;
  project: ProjectRecord;
  referencedSessions: number;
  pendingIntents: number;
}

export class ProjectCatalog {
  readonly workspaceRoot: string;
  private projectWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateStore: ConnectStateStore,
    options: ProjectCatalogOptions = {},
  ) {
    this.workspaceRoot = options.workspaceRoot ?? join(dirname(stateStore.dbPath), "workspaces");
    if (!isAbsolute(this.workspaceRoot)) throw new Error("workspace root must be an absolute path");
  }

  async add(rootPath: string): Promise<ProjectRecord> {
    const canonicalRoot = await existingDirectory(rootPath, "project root");
    return await this.serializeProjectWrite(async () => {
      const duplicate = (await this.stateStore.listProjects()).find((project) => project.rootPath === canonicalRoot);
      if (duplicate) throw new Error(`project root is already registered by ${projectView(duplicate).name}`);
      return projectView(
        await this.stateStore.insertProject({
          projectId: randomUUID(),
          name: requireWorkspaceView(canonicalRoot).id,
          rootPath: canonicalRoot,
        }),
      );
    });
  }

  async ensureRegistered(rootPath: string): Promise<{ project: ProjectRecord; created: boolean }> {
    const canonicalRoot = await existingDirectory(rootPath, "project root");
    return await this.serializeProjectWrite(async () => {
      const existing = (await this.stateStore.listProjects()).find((project) => project.rootPath === canonicalRoot);
      if (existing) return { project: projectView(existing), created: false };
      return {
        project: projectView(
          await this.stateStore.insertProject({
            projectId: randomUUID(),
            name: requireWorkspaceView(canonicalRoot).id,
            rootPath: canonicalRoot,
          }),
        ),
        created: true,
      };
    });
  }

  async get(reference: string): Promise<ProjectRecord | null> {
    const value = reference.trim();
    if (!value) return null;
    return (
      (await this.list()).find(
        (project) => project.projectId === value || this.workspaceId(project).toLowerCase() === value.toLowerCase(),
      ) ?? null
    );
  }

  async require(reference: string): Promise<ProjectRecord> {
    const project = await this.get(reference);
    if (!project) throw new Error(`unknown project: ${reference.trim() || "(empty)"}`);
    return project;
  }

  async list(): Promise<ProjectRecord[]> {
    return (await this.stateStore.listProjects())
      .map(projectView)
      .sort((left, right) => left.name.localeCompare(right.name) || left.rootPath.localeCompare(right.rootPath));
  }

  workspaceId(project: Pick<ProjectRecord, "rootPath">): string {
    return requireWorkspaceView(project.rootPath).id;
  }

  async findForWorkspace(rootPath: string): Promise<ProjectRecord | null> {
    const canonicalRoot = await existingDirectory(rootPath, "Runtime Thread workspace");
    return findProjectForWorkspace(await this.list(), canonicalRoot);
  }

  async ensureDiscoveredWorkspace(rootPath: string): Promise<ProjectRecord | null> {
    if (this.isIsolatedWorkspace(rootPath)) return null;
    const canonicalRoot = await existingDirectory(rootPath, "Runtime Thread workspace");
    return await this.serializeProjectWrite(async () => {
      const existing = (await this.stateStore.listProjects()).find((project) => project.rootPath === canonicalRoot);
      if (existing) return projectView(existing);
      return projectView(
        await this.stateStore.insertProject({
          projectId: randomUUID(),
          name: requireWorkspaceView(canonicalRoot).id,
          rootPath: canonicalRoot,
        }),
      );
    });
  }

  isIsolatedWorkspace(path: string): boolean {
    const nestedPath = relative(resolve(this.workspaceRoot), resolve(path));
    return nestedPath === "" || (!nestedPath.startsWith("..") && !isAbsolute(nestedPath));
  }

  async purgeBindingWorkspaces(agentId: string): Promise<void> {
    await rm(join(this.workspaceRoot, stablePathSegment(agentId)), { recursive: true, force: true });
  }

  async remove(reference: string): Promise<RemoveProjectResult> {
    const project = await this.require(reference);
    const referencedSessions = await this.stateStore.countRuntimeSessionsForProject(project.projectId);
    const pendingIntents = await this.stateStore.countSessionIntentsForProject(project.projectId);
    if (referencedSessions > 0 || pendingIntents > 0)
      return { removed: false, project, referencedSessions, pendingIntents };
    await this.stateStore.deleteRuntimeWorkspaceMappingsForProject(project.projectId);
    return {
      removed: await this.stateStore.deleteProject(project.projectId),
      project,
      referencedSessions: 0,
      pendingIntents: 0,
    };
  }

  async resolveWorkspace(session: RuntimeSessionRecord): Promise<RuntimeWorkspace> {
    if (session.projectId) {
      return await this.resolveProjectWorkspace(session.projectId);
    }
    const workingDirectory = join(
      this.workspaceRoot,
      stablePathSegment(session.agentId),
      stablePathSegment(session.chatId),
      stablePathSegment(session.sessionId),
    );
    await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    return {
      projectId: null,
      workingDirectory,
      skipGitRepoCheck: true,
    };
  }

  async resolveProjectWorkspace(projectId: string): Promise<RuntimeWorkspace> {
    const project = await this.stateStore.getProject(projectId);
    if (!project) throw new Error(`project ${projectId} no longer exists`);
    return {
      projectId: project.projectId,
      workingDirectory: project.rootPath,
      skipGitRepoCheck: true,
    };
  }

  private async serializeProjectWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.projectWrite.then(operation, operation);
    this.projectWrite = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function projectView(project: ProjectRecord): ProjectRecord {
  return { ...project, name: requireWorkspaceView(project.rootPath).name };
}

function requireWorkspaceView(rootPath: string): { id: string; name: string } {
  const workspace = workspaceView(rootPath);
  if (!workspace) throw new Error(`project root has no Workspace identity: ${rootPath}`);
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

function stablePathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
