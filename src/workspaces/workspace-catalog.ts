import { basename, dirname, resolve } from "node:path";

export interface RuntimeWorkspaceChoice {
  workspaceRef: string;
  name: string;
  rootPath: string;
}

export function isWorkspaceRef(value: string): boolean {
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/iu.test(value.trim());
}

export function workspaceView(workingDirectory: string | null | undefined): { name: string } | null {
  if (!workingDirectory) return null;
  const root = resolve(workingDirectory);
  const name = basename(root) || root;
  const parentName = basename(dirname(root));
  return { name: /^\d{4}-\d{2}-\d{2}$/u.test(parentName) ? `${parentName}/${name}` : name };
}
