import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RegularFileWalkDiagnostics {
  readonly symbolicLink: string;
  readonly unsupportedEntry: string;
}

/** Recursively returns every regular file in stable path order without following symbolic links. */
export async function walkRegularFiles(
  root: string,
  diagnostics: RegularFileWalkDiagnostics,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(({ name: left }, { name: right }) => (left < right ? -1 : left > right ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${diagnostics.symbolicLink}: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`${diagnostics.unsupportedEntry}: ${path}`);
    }
  };
  await visit(root);
  return files.sort();
}
