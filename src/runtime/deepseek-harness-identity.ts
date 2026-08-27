import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function canonicalDshHome(
  configured: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): string {
  const native = configured?.trim() || env?.DSH_HOME?.trim() || process.env.DSH_HOME?.trim();
  const selected = native ? expandHome(native) : join(homedir(), ".dsh");
  return canonicalPathBestEffort(resolve(selected));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function canonicalPathBestEffort(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
