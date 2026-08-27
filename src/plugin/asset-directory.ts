import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { walkRegularFiles } from "../regular-file-walker";
import type { ConnectPluginBundleV1 } from "./sdk";

export interface AssetDirectoryDescriptor {
  /** Bundle path prefix beneath which every regular file is copied. */
  readonly entryPrefix: string;
  readonly sourceDirectory: string;
  /** Generated canonical JSON map from Bundle path to exact sha256 SRI. */
  readonly integrityManifestEntry: string;
}

export interface AssembleAssetDirectoriesOptions {
  /** Base directory against which descriptor source directories are resolved. */
  readonly sourceRoot: string;
  /** Caller name used in packaging diagnostics, such as "Plugin" or "Official Plugin". */
  readonly label: string;
}

/** Adds complete, deterministic asset directories and their integrity manifests to Bundle files. */
export async function assembleAssetDirectories(
  files: ConnectPluginBundleV1["files"],
  directories: readonly AssetDirectoryDescriptor[],
  options: AssembleAssetDirectoriesOptions,
): Promise<void> {
  for (const directory of directories) {
    const sourceRoot = resolve(options.sourceRoot, directory.sourceDirectory);
    const integrities: Record<string, string> = {};
    for (const sourcePath of await walkRegularFiles(sourceRoot, {
      symbolicLink: `${options.label} asset directories cannot contain symbolic links`,
      unsupportedEntry: `${options.label} asset directory contains an unsupported entry`,
    })) {
      const relativePath = relative(sourceRoot, sourcePath).split(sep).join("/");
      const entry = `${directory.entryPrefix.replace(/\/+$/u, "")}/${relativePath}`;
      if (Object.hasOwn(files, entry)) {
        throw new Error(`${options.label} Bundle asset path is duplicated: ${entry}`);
      }
      const bytes = await readFile(sourcePath);
      files[entry] = { encoding: "base64", content: bytes.toString("base64") };
      integrities[entry] = sha256Integrity(bytes);
    }
    if (Object.keys(integrities).length === 0) {
      throw new Error(`${options.label} asset directory is empty: ${directory.sourceDirectory}`);
    }
    if (Object.hasOwn(files, directory.integrityManifestEntry)) {
      throw new Error(`${options.label} Bundle asset path is duplicated: ${directory.integrityManifestEntry}`);
    }
    const canonicalIntegrities = Object.fromEntries(
      Object.entries(integrities).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    files[directory.integrityManifestEntry] = {
      encoding: "utf8",
      content: `${JSON.stringify(canonicalIntegrities, null, 2)}\n`,
    };
  }
}

function sha256Integrity(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}
