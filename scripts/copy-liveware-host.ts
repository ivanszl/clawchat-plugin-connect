import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { livewareAssetName } from "../src/service/liveware-exposure";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asset = livewareAssetName(process.platform, process.arch);
const output = resolve(
  process.argv[2] ?? join(repositoryRoot, "dist", process.platform === "win32" ? "liveware.exe" : "liveware"),
);
const verification = Bun.spawn([process.execPath, join(repositoryRoot, "scripts", "verify-liveware-bundle.ts"), asset], {
  cwd: repositoryRoot,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await verification.exited) !== 0) throw new Error(`Liveware verification failed for ${asset}`);
await mkdir(dirname(output), { recursive: true });
await copyFile(join(repositoryRoot, "vendor", "liveware", asset), output);
if (process.platform !== "win32") await chmod(output, 0o755);
