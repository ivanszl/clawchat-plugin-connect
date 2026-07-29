import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ProjectRecord } from "./types";

export interface RuntimeWorkspaceChoice {
  workspaceId: string;
  name: string;
  rootPath: string;
  projectId: string | null;
  projectName: string | null;
}

export function workspaceView(workingDirectory: string | null | undefined): { id: string; name: string } | null {
  if (!workingDirectory) return null;
  const root = resolve(workingDirectory);
  const name = basename(root) || root;
  const parentName = basename(dirname(root));
  return {
    id: createHash("sha256").update(root).digest("hex").slice(0, 24),
    name: /^\d{4}-\d{2}-\d{2}$/u.test(parentName) ? `${parentName}/${name}` : name,
  };
}

export function findProjectForWorkspace(projects: ProjectRecord[], workingDirectory: string): ProjectRecord | null {
  const workspace = resolve(workingDirectory);
  return (
    projects
      .filter((project) => pathContains(resolve(project.rootPath), workspace))
      .sort((left, right) => resolve(right.rootPath).length - resolve(left.rootPath).length)[0] ?? null
  );
}

function pathContains(root: string, candidate: string): boolean {
  const nestedPath = relative(root, candidate);
  return nestedPath === "" || (!nestedPath.startsWith("..") && !isAbsolute(nestedPath));
}
