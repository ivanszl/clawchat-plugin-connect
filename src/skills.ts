import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECT_VERSION } from "./version";

const MANIFEST_NAME = ".clawchat-connect-manifest.json";

interface SkillsManifest {
  connectVersion: string;
  files: Record<string, string>;
}

export async function installManagedSkills(
  options: { sourceDirectory?: string; targetRoot?: string } = {},
): Promise<{ targetRoot: string; skills: string[] }> {
  const source = options.sourceDirectory ?? (await resolveBundledSkillsDirectory());
  const targetRoot = resolve(options.targetRoot ?? join(homedir(), ".agents", "skills"));
  await preflightManagedSkills({ sourceDirectory: source, targetRoot });
  const manifest = await readAndVerifyManifest(source);
  const transactionId = process.pid;
  const entries = ["clawchat-core", "clawchat-liveware"].map((skill) => ({
    target: join(targetRoot, skill),
    staging: join(targetRoot, `.${skill}.new-${transactionId}`),
    backup: join(targetRoot, `.${skill}.old-${transactionId}`),
    source: join(source, skill),
  }));
  entries.push({
    target: join(targetRoot, MANIFEST_NAME),
    staging: join(targetRoot, `.${MANIFEST_NAME}.new-${transactionId}`),
    backup: join(targetRoot, `.${MANIFEST_NAME}.old-${transactionId}`),
    source: join(source, "manifest.json"),
  });
  for (const entry of entries) {
    await rm(entry.staging, { recursive: true, force: true });
    await rm(entry.backup, { recursive: true, force: true });
    if (entry.target.endsWith(MANIFEST_NAME)) {
      await writeFile(entry.staging, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } else {
      await cp(entry.source, entry.staging, { recursive: true });
    }
  }
  const backedUp: typeof entries = [];
  const installed: typeof entries = [];
  try {
    for (const entry of entries) {
      if (await pathExists(entry.target)) {
        await rename(entry.target, entry.backup);
        backedUp.push(entry);
      }
    }
    for (const entry of entries) {
      await rename(entry.staging, entry.target);
      installed.push(entry);
    }
    await verifyInstalledSkills({ sourceDirectory: source, targetRoot });
  } catch (error) {
    for (const entry of installed.reverse()) await rm(entry.target, { recursive: true, force: true });
    for (const entry of backedUp.reverse()) {
      if (await pathExists(entry.backup)) await rename(entry.backup, entry.target);
    }
    for (const entry of entries) await rm(entry.staging, { recursive: true, force: true });
    throw error;
  }
  for (const entry of backedUp) await rm(entry.backup, { recursive: true, force: true });
  return { targetRoot, skills: ["clawchat-core", "clawchat-liveware"] };
}

export async function preflightManagedSkills(
  options: { sourceDirectory?: string; targetRoot?: string } = {},
): Promise<{ targetRoot: string }> {
  const source = options.sourceDirectory ?? (await resolveBundledSkillsDirectory());
  const targetRoot = resolve(options.targetRoot ?? join(homedir(), ".agents", "skills"));
  await readAndVerifyManifest(source);
  await mkdir(targetRoot, { recursive: true });
  const transactionId = randomUUID();
  const probe = join(targetRoot, `.clawchat-connect-preflight-${transactionId}`);
  const moved = `${probe}.moved`;
  try {
    await writeFile(probe, "preflight", { flag: "wx" });
    await rename(probe, moved);
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
    await rm(moved, { force: true }).catch(() => undefined);
  }
  return { targetRoot };
}

export async function verifyInstalledSkills(
  options: { sourceDirectory?: string; targetRoot?: string } = {},
): Promise<void> {
  const source = options.sourceDirectory ?? (await resolveBundledSkillsDirectory());
  const targetRoot = resolve(options.targetRoot ?? join(homedir(), ".agents", "skills"));
  const expected = await readAndVerifyManifest(source);
  let installed: SkillsManifest;
  try {
    installed = JSON.parse(await readFile(join(targetRoot, MANIFEST_NAME), "utf8")) as SkillsManifest;
  } catch {
    throw new Error("managed Agent skills are missing; run `clawchat-connect skills install`");
  }
  if (
    installed.connectVersion !== CONNECT_VERSION ||
    JSON.stringify(installed.files) !== JSON.stringify(expected.files)
  )
    throw new Error("managed Agent skills do not match this Connect release; run `clawchat-connect skills install`");
  for (const [relativePath, expectedHash] of Object.entries(expected.files)) {
    const actualHash = await sha256(join(targetRoot, relativePath)).catch(() => "");
    if (actualHash !== expectedHash)
      throw new Error(
        `managed Agent skill file ${relativePath} was changed or is missing; run \`clawchat-connect skills install\``,
      );
  }
}

export async function resolveBundledSkillsDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(dirname(resolve(process.execPath)), "skills"),
    join(moduleDirectory, "..", "skills"),
    join(moduleDirectory, "..", "..", "skills"),
    join(moduleDirectory, "..", "..", "..", "skills"),
  ];
  for (const candidate of candidates) if (await pathExists(join(candidate, "manifest.json"))) return resolve(candidate);
  throw new Error("bundled Agent skills are missing; reinstall ClawChat Connect");
}

async function readAndVerifyManifest(source: string): Promise<SkillsManifest> {
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as SkillsManifest;
  if (manifest.connectVersion !== CONNECT_VERSION)
    throw new Error(`bundled Agent skills target Connect ${manifest.connectVersion}, expected ${CONNECT_VERSION}`);
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    if (!relativePath.startsWith("clawchat-core/") && !relativePath.startsWith("clawchat-liveware/"))
      throw new Error(`invalid managed skill path ${relativePath}`);
    if ((await sha256(join(source, relativePath))) !== expectedHash)
      throw new Error(`bundled Agent skill checksum mismatch: ${relativePath}`);
  }
  return manifest;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}
