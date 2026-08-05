import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CONNECT_TOOL_CATALOG, toolJsonSchema } from "../src/agent/tool-catalog";
import { CONNECT_VERSION } from "../src/service/version";

const skillsRoot = new URL("../skills", import.meta.url).pathname;
const referenceLines = [
  "# ClawChat tool reference",
  "",
  "This file is generated from `src/agent/tool-catalog.ts`. Do not edit it directly.",
  "",
];
for (const tool of CONNECT_TOOL_CATALOG) {
  referenceLines.push(`## \`${tool.name}\``, "", tool.description, "", "Input:", "", "```json");
  referenceLines.push(JSON.stringify(toolJsonSchema(tool), null, 2), "```", "");
}
const expectedReference = `${referenceLines.join("\n")}\n`;
const referencePath = join(skillsRoot, "clawchat-core", "references", "tools.md");
if ((await readFile(referencePath, "utf8")) !== expectedReference) {
  throw new Error("generated tool reference is stale; run `bun scripts/generate-tool-reference.ts`");
}

const files: string[] = [];
for (const skill of ["clawchat-core", "clawchat-liveware"]) await walk(join(skillsRoot, skill));
files.sort();
const checksums = Object.fromEntries(
  await Promise.all(
    files.map(async (path) => [
      relative(skillsRoot, path),
      createHash("sha256").update(await readFile(path)).digest("hex"),
    ]),
  ),
);
const expectedManifest = `${JSON.stringify({ connectVersion: CONNECT_VERSION, files: checksums }, null, 2)}\n`;
if ((await readFile(join(skillsRoot, "manifest.json"), "utf8")) !== expectedManifest) {
  throw new Error("generated skills manifest is stale; run `bun scripts/generate-skills-manifest.ts`");
}

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push(path);
  }
}
