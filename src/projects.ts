import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ConnectStateStore } from "./state";
import type { ProjectRecord, RuntimeSessionRecord, RuntimeWorkspace } from "./types";

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

  constructor(
    private readonly stateStore: ConnectStateStore,
    options: ProjectCatalogOptions = {},
  ) {
    this.workspaceRoot = options.workspaceRoot ?? join(dirname(stateStore.dbPath), "workspaces");
    if (!isAbsolute(this.workspaceRoot)) throw new Error("workspace root must be an absolute path");
  }

  async add(name: string, rootPath: string, additionalDirectories: string[] = []): Promise<ProjectRecord> {
    const normalizedName = normalizeProjectName(name);
    const canonicalRoot = await existingDirectory(rootPath, "project root");
    const canonicalAdditional = await Promise.all(
      additionalDirectories.map((path) => existingDirectory(path, "additional project directory")),
    );
    const duplicate = (await this.stateStore.listProjects()).find(
      (project) => project.name.toLowerCase() === normalizedName.toLowerCase() || project.rootPath === canonicalRoot,
    );
    if (duplicate) {
      const field = duplicate.rootPath === canonicalRoot ? "root" : "name";
      throw new Error(`project ${field} is already registered by ${duplicate.name}`);
    }
    return await this.stateStore.insertProject({
      projectId: randomUUID(),
      name: normalizedName,
      rootPath: canonicalRoot,
      additionalDirectories: [...new Set(canonicalAdditional)].filter((path) => path !== canonicalRoot),
    });
  }

  async get(reference: string): Promise<ProjectRecord | null> {
    const value = reference.trim();
    return value ? await this.stateStore.getProject(value) : null;
  }

  async require(reference: string): Promise<ProjectRecord> {
    const project = await this.get(reference);
    if (!project) throw new Error(`unknown project: ${reference.trim() || "(empty)"}`);
    return project;
  }

  async list(): Promise<ProjectRecord[]> {
    return await this.stateStore.listProjects();
  }

  async ensureDiscoveredWorkspace(rootPath: string): Promise<ProjectRecord | null> {
    if (this.isIsolatedWorkspace(rootPath)) return null;
    const canonicalRoot = await existingDirectory(rootPath, "Runtime Thread workspace");
    const projects = await this.stateStore.listProjects();
    const existing = projects.find((project) => project.rootPath === canonicalRoot);
    if (existing) return existing;
    const baseName = discoveredProjectName(basename(canonicalRoot));
    const conflictingName = projects.some((project) => project.name.toLowerCase() === baseName.toLowerCase());
    const name = conflictingName
      ? `${baseName}-${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 8)}`
      : baseName;
    return await this.stateStore.insertProject({
      projectId: randomUUID(),
      name,
      rootPath: canonicalRoot,
      additionalDirectories: [],
    });
  }

  isIsolatedWorkspace(path: string): boolean {
    const nestedPath = relative(resolve(this.workspaceRoot), resolve(path));
    return nestedPath === "" || (!nestedPath.startsWith("..") && !isAbsolute(nestedPath));
  }

  async remove(reference: string): Promise<RemoveProjectResult> {
    const project = await this.require(reference);
    const referencedSessions = await this.stateStore.countRuntimeSessionsForProject(project.projectId);
    const pendingIntents = await this.stateStore.countSessionIntentsForProject(project.projectId);
    if (referencedSessions > 0 || pendingIntents > 0)
      return { removed: false, project, referencedSessions, pendingIntents };
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
      additionalDirectories: [],
      skipGitRepoCheck: true,
    };
  }

  async resolveProjectWorkspace(projectId: string): Promise<RuntimeWorkspace> {
    const project = await this.stateStore.getProject(projectId);
    if (!project) throw new Error(`project ${projectId} no longer exists`);
    return {
      projectId: project.projectId,
      workingDirectory: project.rootPath,
      additionalDirectories: project.additionalDirectories,
      skipGitRepoCheck: true,
    };
  }
}

function normalizeProjectName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("project name is required");
  if (/\s/u.test(name)) throw new Error("project name cannot contain whitespace");
  if (name.length > 100) throw new Error("project name cannot exceed 100 characters");
  return name;
}

function discoveredProjectName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, "-").slice(0, 100);
  return normalized || "workspace";
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
