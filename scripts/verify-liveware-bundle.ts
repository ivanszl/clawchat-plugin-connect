import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = join(repositoryRoot, "vendor", "liveware");
const manifestText = await readFile(join(bundleDirectory, "SHA256SUMS"), "utf8");
const manifest = new Map(
  manifestText
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([checksum, asset]) => [asset, checksum]),
);
const requestedAsset = process.argv[2]?.trim();
const assets = requestedAsset ? [requestedAsset] : [...manifest.keys()];

for (const asset of assets) {
  const expected = manifest.get(asset);
  if (!expected) throw new Error(`Liveware checksum is not pinned for ${asset}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(bundleDirectory, asset))) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`Liveware ${asset} checksum mismatch: expected ${expected}, got ${actual}`);
  }
}
