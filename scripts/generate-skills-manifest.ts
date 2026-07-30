import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CONNECT_VERSION } from "../src/version";

const root = new URL("../skills", import.meta.url).pathname;
const files: string[] = [];
for (const skill of ["clawchat-core", "clawchat-liveware"]) await walk(join(root, skill));
files.sort();
const checksums = Object.fromEntries(
  await Promise.all(files.map(async (path) => [
    relative(root, path),
    createHash("sha256").update(await readFile(path)).digest("hex"),
  ])),
);
await Bun.write(join(root, "manifest.json"), `${JSON.stringify({ connectVersion: CONNECT_VERSION, files: checksums }, null, 2)}\n`);

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push(path);
  }
}
