import { lstat, mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import type {
  HostDirectoryEntryView,
  HostDirectoryListingView,
  HostDirectoryLocationView,
  WorkspaceDirectoryRequest,
} from "../client-contract";

export class HostDirectoryError extends Error {
  constructor(
    readonly code:
      | "invalid-directory"
      | "directory-not-found"
      | "directory-unavailable"
      | "directory-already-exists"
      | "invalid-directory-name",
    message: string,
  ) {
    super(message);
  }
}

export interface HostDirectoryShortcut {
  kind: "workspace" | "runtime-workspace";
  name: string;
  path: string;
}

export interface MaterializedWorkspaceDirectory {
  rootPath: string;
  createdDirectory: boolean;
  rollback(): Promise<void>;
}

export async function listHostDirectories(options: {
  path: string | null;
  showHidden: boolean;
  shortcuts: HostDirectoryShortcut[];
}): Promise<HostDirectoryListingView> {
  const locations = await hostDirectoryLocations(options.shortcuts);
  if (!options.path) return { currentPath: null, parentPath: null, separator: sep, locations, entries: [] };
  const currentPath = await existingDirectory(options.path, "directory");
  const directoryEntries = await readdir(currentPath, { withFileTypes: true }).catch((error: unknown) => {
    throw new HostDirectoryError(
      "directory-unavailable",
      `Directory cannot be opened: ${currentPath}${systemErrorDetail(error)}`,
    );
  });
  const entries = (
    await Promise.all(
      directoryEntries
        .filter((entry) => options.showHidden || !entry.name.startsWith("."))
        .map(async (entry): Promise<HostDirectoryEntryView | null> => {
          const path = join(currentPath, entry.name);
          const symbolicLink = entry.isSymbolicLink();
          if (!entry.isDirectory() && !symbolicLink) return null;
          try {
            const canonicalPath = await realpath(path);
            if (!(await stat(canonicalPath)).isDirectory()) return null;
            return { name: entry.name, path, canonicalPath, isSymbolicLink: symbolicLink };
          } catch {
            return null;
          }
        }),
    )
  )
    .filter((entry): entry is HostDirectoryEntryView => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = dirname(currentPath);
  return {
    currentPath,
    parentPath: parent === currentPath ? null : parent,
    separator: sep,
    locations,
    entries,
  };
}

export async function materializeWorkspaceDirectory(
  request: WorkspaceDirectoryRequest,
): Promise<MaterializedWorkspaceDirectory> {
  if (request.kind === "existing-directory") {
    const rootPath = await existingDirectory(request.rootPath, "workspace root");
    return { rootPath, createdDirectory: false, rollback: async () => undefined };
  }
  const parentPath = await existingDirectory(request.parentPath, "workspace parent");
  const name = validDirectoryName(request.name);
  const requestedPath = join(parentPath, name);
  try {
    await mkdir(requestedPath);
  } catch (error) {
    if (systemErrorCode(error) === "EEXIST")
      throw new HostDirectoryError("directory-already-exists", `Directory already exists: ${requestedPath}`);
    throw new HostDirectoryError(
      "directory-unavailable",
      `Directory could not be created: ${requestedPath}${systemErrorDetail(error)}`,
    );
  }
  const rootPath = await realpath(requestedPath);
  return {
    rootPath,
    createdDirectory: true,
    rollback: async () => {
      await rmdir(rootPath).catch(() => undefined);
    },
  };
}

async function hostDirectoryLocations(shortcuts: HostDirectoryShortcut[]): Promise<HostDirectoryLocationView[]> {
  const candidates: Array<Omit<HostDirectoryLocationView, "id">> = [];
  const home = await realpath(homedir()).catch(() => homedir());
  candidates.push({ kind: "home", name: "主目录", path: home });
  for (const root of await filesystemRoots(home)) candidates.push({ kind: "filesystem-root", name: root, path: root });
  for (const volume of await mountedVolumes())
    candidates.push({ kind: "mounted-volume", name: basename(volume) || volume, path: volume });
  for (const shortcut of shortcuts) candidates.push(shortcut);

  const seen = new Set<string>();
  const locations: HostDirectoryLocationView[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await existingDirectory(candidate.path, candidate.name).catch(() => null);
    if (!canonicalPath || seen.has(canonicalPath)) continue;
    seen.add(canonicalPath);
    locations.push({
      ...candidate,
      id: `${candidate.kind}:${canonicalPath}`,
      path: canonicalPath,
    });
  }
  return locations;
}

async function filesystemRoots(home: string): Promise<string[]> {
  if (platform() !== "win32") return [parse(home).root];
  const roots = await Promise.all(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async (letter) => {
      const root = `${letter}:\\`;
      return (await stat(root).catch(() => null))?.isDirectory() ? root : null;
    }),
  );
  return roots.filter((root): root is string => root !== null);
}

async function mountedVolumes(): Promise<string[]> {
  const roots = platform() === "darwin" ? ["/Volumes"] : platform() === "linux" ? ["/mnt", "/media", "/run/media"] : [];
  const volumes: string[] = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      volumes.push(join(root, entry.name));
    }
  }
  return volumes;
}

async function existingDirectory(value: string, label: string): Promise<string> {
  const path = value.trim();
  if (!path || !isAbsolute(path))
    throw new HostDirectoryError("invalid-directory", `${label} must be an absolute path`);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    throw new HostDirectoryError("directory-not-found", `${label} does not exist: ${path}`);
  }
  const details = await lstat(canonicalPath).catch(() => null);
  if (!details?.isDirectory())
    throw new HostDirectoryError("invalid-directory", `${label} is not a directory: ${path}`);
  return canonicalPath;
}

function validDirectoryName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name))
    throw new HostDirectoryError("invalid-directory-name", "Directory name must be one path segment");
  return name;
}

function systemErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function systemErrorDetail(error: unknown): string {
  const code = systemErrorCode(error);
  return code ? ` (${code})` : "";
}
