import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function installManagedSkillsFromPackage(
  entrypoint = fileURLToPath(new URL("../dist/src/bin.js", import.meta.url)),
): number {
  if (!existsSync(entrypoint)) return 0;
  const result = Bun.spawnSync([process.execPath, entrypoint, "skills", "install"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode ?? 1;
}

if (import.meta.main) process.exitCode = installManagedSkillsFromPackage();
