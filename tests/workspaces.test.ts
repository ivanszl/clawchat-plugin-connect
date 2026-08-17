import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createStateStore } from "../src/persistence/state";
import { synchronizeRuntimeWorkspaces } from "../src/workspaces/workspace-synchronizer";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-workspaces-"));
  const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await store.initialize();
  let sequence = 0;
  const workspaces = new WorkspaceCatalog(store, {
    workspaceRoot: join(directory, "managed"),
    workspaceRefFactory: () => `WS${String(++sequence).padStart(6, "0")}`,
  });
  return { directory, store, workspaces };
}

describe("WorkspaceCatalog", () => {
  it("creates one binding-scoped default Workspace with a private managed root", async () => {
    const { directory, store, workspaces } = await fixture();

    const first = await workspaces.ensureDefault("codex");
    const repeated = await workspaces.ensureDefault("codex");
    const otherBinding = await workspaces.ensureDefault("opencode");

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      bindingId: "codex",
      workspaceRef: "WS000001",
      name: "Default",
      selectable: true,
    });
    expect(otherBinding).toMatchObject({ bindingId: "opencode", workspaceRef: "WS000002" });
    expect(first.rootPath).not.toBe(otherBinding.rootPath);
    expect((await stat(first.rootPath)).isDirectory()).toBe(true);
    expect(first.rootPath.startsWith(join(directory, "managed"))).toBe(true);

    await store.close();
  });

  it("adds canonical local roots independently for each Agent Binding", async () => {
    const { directory, store, workspaces } = await fixture();
    const root = join(directory, "repo");
    await mkdir(root);

    const codex = await workspaces.add("codex", root);
    const duplicate = await workspaces.add("codex", join(root, "."));
    const opencode = await workspaces.add("opencode", root);

    expect(duplicate).toEqual(codex);
    expect(codex).toMatchObject({
      bindingId: "codex",
      source: "runtime",
      name: basename(root),
      rootPath: await realpath(root),
      selectable: true,
    });
    expect(opencode.bindingId).toBe("opencode");
    expect(opencode.workspaceRef).not.toBe(codex.workspaceRef);

    await store.close();
  });

  it("reconciles only persistent Runtime Workspace identities and reports discovery failures", async () => {
    const { directory, store, workspaces } = await fixture();
    const persistentRoot = join(directory, "persistent");
    const transientRoot = join(directory, "transient");
    await Promise.all([mkdir(persistentRoot), mkdir(transientRoot)]);

    const synchronized = await synchronizeRuntimeWorkspaces({
      bindingId: "codex",
      workspaces,
      snapshot: {
        status: "complete",
        identities: [
          { key: "persistent-id", kind: "persistent", localRoot: persistentRoot },
          { key: "transient-id", kind: "transient", localRoot: transientRoot },
        ],
      },
    });

    expect(synchronized.failures).toEqual([]);
    expect(synchronized.workspaces).toEqual([
      expect.objectContaining({ source: "default", bindingId: "codex" }),
      expect.objectContaining({ runtimeIdentityKey: "persistent-id", rootPath: await realpath(persistentRoot) }),
    ]);

    const failed = await synchronizeRuntimeWorkspaces({
      bindingId: "codex",
      workspaces,
      snapshot: {
        status: "complete",
        identities: [{ key: "missing", kind: "persistent", localRoot: join(directory, "missing") }],
      },
    });
    expect(failed.failures).toEqual([expect.stringContaining("does not exist")]);
    expect(failed.workspaces).toEqual(synchronized.workspaces);

    await store.close();
  });

  it("keeps valid Runtime Workspaces when one discovered root no longer exists", async () => {
    const { directory, store, workspaces } = await fixture();
    const availableRoot = join(directory, "available");
    await mkdir(availableRoot);

    const synchronized = await synchronizeRuntimeWorkspaces({
      bindingId: "codex",
      workspaces,
      snapshot: {
        status: "complete",
        identities: [
          { key: "available", kind: "persistent", localRoot: availableRoot },
          { key: "missing", kind: "persistent", localRoot: join(directory, "missing") },
        ],
      },
    });

    expect(synchronized.failures).toEqual([expect.stringContaining("does not exist")]);
    expect(synchronized.workspaces).toEqual([
      expect.objectContaining({ source: "default", bindingId: "codex" }),
      expect.objectContaining({ runtimeIdentityKey: "available", rootPath: await realpath(availableRoot) }),
    ]);

    await store.close();
  });

  it("resolves a Session without a selection to the binding default Workspace", async () => {
    const { directory, store, workspaces } = await fixture();
    const selectedRoot = join(directory, "selected");
    await mkdir(selectedRoot);
    const selected = await workspaces.add("codex", selectedRoot);

    await expect(workspaces.resolveWorkspace({ agentId: "codex", workspaceRef: null })).resolves.toMatchObject({
      workspaceRef: "WS000002",
      skipGitRepoCheck: true,
    });
    await expect(
      workspaces.resolveWorkspace({ agentId: "codex", workspaceRef: selected.workspaceRef }),
    ).resolves.toEqual({
      workspaceRef: selected.workspaceRef,
      workingDirectory: await realpath(selectedRoot),
      skipGitRepoCheck: true,
    });

    await store.close();
  });

  it("rejects removal while a Session references the Workspace", async () => {
    const { directory, store, workspaces } = await fixture();
    const root = join(directory, "referenced");
    await mkdir(root);
    const workspace = await workspaces.add("codex", root);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      workspaceRef: workspace.workspaceRef,
    });

    await expect(workspaces.remove("codex", workspace.workspaceRef)).rejects.toThrow("used by 1 Session");
    await store.deleteRuntimeSession("chat-1", "codex", "session-1");
    await expect(workspaces.remove("codex", workspace.workspaceRef)).resolves.toEqual(workspace);
    await expect(workspaces.get("codex", workspace.workspaceRef)).resolves.toBeNull();

    await store.close();
  });

  it("purges only one Binding catalog while preserving every Workspace file", async () => {
    const { store, workspaces } = await fixture();
    const codexDefault = await workspaces.ensureDefault("codex");
    const opencodeDefault = await workspaces.ensureDefault("opencode");
    const preservedFile = join(codexDefault.rootPath, "notes.txt");
    await writeFile(preservedFile, "preserve me");
    await workspaces.purgeBindingCatalog("codex");

    await expect(workspaces.get("codex", codexDefault.workspaceRef)).resolves.toBeNull();
    expect((await stat(codexDefault.rootPath)).isDirectory()).toBe(true);
    expect(await readFile(preservedFile, "utf8")).toBe("preserve me");
    await expect(workspaces.get("opencode", opencodeDefault.workspaceRef)).resolves.toEqual(opencodeDefault);
    expect((await stat(opencodeDefault.rootPath)).isDirectory()).toBe(true);

    await store.close();
  });
});
