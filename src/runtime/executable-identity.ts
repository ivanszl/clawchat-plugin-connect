import { realpathSync, statSync } from "node:fs";

export interface CanonicalExecutableIdentity {
  readonly path: string;
  readonly identity: string;
}

/** Resolves an executable to the regular file that the operating system will run. */
export function canonicalExecutableIdentity(
  executable: string,
  productName: string,
): CanonicalExecutableIdentity {
  let path: string;
  try {
    path = realpathSync(executable);
  } catch (error) {
    throw new Error(`${productName} executable identity could not be resolved: ${executable}`, { cause: error });
  }

  let stats;
  try {
    stats = statSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`${productName} executable identity could not be inspected: ${path}`, { cause: error });
  }
  if (!stats.isFile()) throw new Error(`${productName} executable is not a regular file: ${path}`);

  return {
    path,
    identity: JSON.stringify({ path, device: stats.dev.toString(), inode: stats.ino.toString() }),
  };
}
