import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HostDirectoryError,
  listHostDirectories,
  materializeProjectDirectory,
} from "../src/projects/host-directories";

describe("host directory selection", () => {
  it("lists only directories, hides dot directories by default, and resolves symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawchat-connect-directories-"));
    const visible = join(root, "visible");
    const hidden = join(root, ".hidden");
    const link = join(root, "linked");
    await mkdir(visible);
    await mkdir(hidden);
    await writeFile(join(root, "file.txt"), "not a directory");
    const linked = await symlink(visible, link, "dir")
      .then(() => true)
      .catch(() => false);

    const listing = await listHostDirectories({
      path: root,
      showHidden: false,
      shortcuts: [{ kind: "project", name: "Visible", path: visible }],
    });
    expect(listing.currentPath).toBe(await realpath(root));
    expect(listing.entries.map((entry) => entry.name)).toContain("visible");
    expect(listing.entries.map((entry) => entry.name)).not.toContain(".hidden");
    expect(listing.entries.map((entry) => entry.name)).not.toContain("file.txt");
    expect(listing.locations).toContainEqual(
      expect.objectContaining({ kind: "project", name: "Visible", path: await realpath(visible) }),
    );
    if (linked) {
      expect(listing.entries).toContainEqual(
        expect.objectContaining({
          name: "linked",
          canonicalPath: await realpath(visible),
          isSymbolicLink: true,
        }),
      );
    }

    const showingHidden = await listHostDirectories({ path: root, showHidden: true, shortcuts: [] });
    expect(showingHidden.entries.map((entry) => entry.name)).toContain(".hidden");
  });

  it("creates a staged child directory and removes it only while it remains empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawchat-connect-new-directory-"));
    const empty = await materializeProjectDirectory({ kind: "new-directory", parentPath: root, name: "empty" });
    expect((await stat(empty.rootPath)).isDirectory()).toBe(true);
    await empty.rollback();
    await expect(stat(empty.rootPath).catch(() => null)).resolves.toBeNull();

    const populated = await materializeProjectDirectory({
      kind: "new-directory",
      parentPath: root,
      name: "populated",
    });
    await writeFile(join(populated.rootPath, "README.md"), "keep me");
    await populated.rollback();
    expect((await stat(populated.rootPath)).isDirectory()).toBe(true);
  });

  it("rejects path traversal and an existing new-folder name", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawchat-connect-invalid-directory-"));
    await expect(
      materializeProjectDirectory({ kind: "new-directory", parentPath: root, name: "../escape" }),
    ).rejects.toMatchObject({ code: "invalid-directory-name" } satisfies Partial<HostDirectoryError>);
    await mkdir(join(root, "existing"));
    await expect(
      materializeProjectDirectory({ kind: "new-directory", parentPath: root, name: "existing" }),
    ).rejects.toMatchObject({ code: "directory-already-exists" } satisfies Partial<HostDirectoryError>);
  });
});
