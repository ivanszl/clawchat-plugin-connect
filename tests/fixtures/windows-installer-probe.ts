import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [command, action] = process.argv.slice(2);

if (command === "--help" || (command === "service" && action === "stop")) process.exit(0);

if (command === "skills" && action === "install") process.exit(0);

if (command === "skills" && action === "preflight") {
  const installedPath = process.env.CONNECT_TEST_INSTALLED_BINARY;
  const expectedHash = process.env.CONNECT_TEST_OLD_BINARY_HASH;
  const observationPath = process.env.CONNECT_TEST_PREFLIGHT_OBSERVATION;
  const invalidParent = process.env.CONNECT_TEST_INVALID_SKILL_PARENT;
  if (!installedPath || !expectedHash || !observationPath || !invalidParent) process.exit(19);
  const actualHash = createHash("sha256")
    .update(await readFile(installedPath))
    .digest("hex");
  await writeFile(observationPath, actualHash === expectedHash ? "old\n" : "replaced\n");
  try {
    await mkdir(join(invalidParent, "skills"), { recursive: true });
  } catch {
    process.exit(17);
  }
  process.exit(18);
}

process.exit(1);
