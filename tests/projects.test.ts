import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createStateStore } from "../src/persistence/state";
import { synchronizeRuntimeProjects } from "../src/projects/project-synchronizer";
import { ProjectCatalog } from "../src/projects/projects";
import type { RuntimeSessionRecord } from "../src/types";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-projects-"));
  const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
  const projects = new ProjectCatalog(store);
  return { directory, store, projects };
}

function session(overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord {
  return {
    chatId: "chat-1",
    sessionId: "session-1",
    sessionRef: "ABCDEFGH",
    agentId: "work",
    runtimeSessionId: null,
    projectId: null,
    name: null,
    mode: null,
    model: null,
    reasoningEffort: null,
    hasMessages: true,
    isCurrent: true,
    updatedAt: 1,
    ...overrides,
  };
}

describe("ProjectCatalog", () => {
  it("derives Project names and Workspace IDs from canonical roots instead of stored aliases", async () => {
    const { directory, store, projects } = await fixture();
    const root = await mkdtemp(join(directory, "clawchat-plugin-connect-"));
    await store.insertProject({
      projectId: "project-legacy",
      name: "connect-qa",
      rootPath: await realpath(root),
    });

    await expect(projects.list()).resolves.toEqual([
      expect.objectContaining({
        projectId: "project-legacy",
        name: root.split("/").at(-1),
        rootPath: await realpath(root),
      }),
    ]);
    const listed = (await projects.list())[0];
    expect(listed).toBeDefined();
    if (!listed) throw new Error("expected Project");
    expect(projects.workspaceId(listed)).toMatch(/^[a-f0-9]{24}$/u);
    await store.close();
  });

  it("synchronizes active persistent Runtime Workspaces into Projects without importing transient roots", async () => {
    const { directory, store, projects } = await fixture();
    const persistentRoot = await mkdtemp(join(directory, "persistent-"));
    const transientRoot = await mkdtemp(join(directory, "transient-"));
    const archivedRoot = await mkdtemp(join(directory, "archived-"));

    const result = await synchronizeRuntimeProjects({
      bindingId: "codex",
      runtimeKind: "codex",
      projects,
      stateStore: store,
      threads: [
        {
          runtimeThreadId: "thread-persistent",
          name: "Persistent",
          updatedAt: 2,
          workingDirectory: persistentRoot,
          workspaceIdentity: { key: "native-persistent", kind: "persistent", localRoot: persistentRoot },
        },
        {
          runtimeThreadId: "thread-transient",
          name: "Transient",
          updatedAt: 1,
          workingDirectory: transientRoot,
          workspaceKind: "transient",
          workspaceIdentity: { key: "native-transient", kind: "transient", localRoot: transientRoot },
        },
        {
          runtimeThreadId: "thread-archived",
          name: "Archived",
          updatedAt: 0,
          workingDirectory: archivedRoot,
          isArchived: true,
          workspaceIdentity: { key: "native-archived", kind: "persistent", localRoot: archivedRoot },
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.projects).toEqual([
      expect.objectContaining({
        name: persistentRoot.split("/").at(-1),
        rootPath: await realpath(persistentRoot),
      }),
    ]);
    await expect(store.getRuntimeWorkspaceMapping("codex", "codex", "native-persistent")).resolves.toMatchObject({
      projectId: result.projects[0]?.projectId,
    });
    await expect(store.getRuntimeWorkspaceMapping("codex", "codex", "native-transient")).resolves.toBeNull();
    await expect(store.getRuntimeWorkspaceMapping("codex", "codex", "native-archived")).resolves.toBeNull();
    const synchronized = result.projects[0];
    expect(synchronized).toBeDefined();
    if (!synchronized) throw new Error("expected synchronized Project");
    await expect(projects.remove(projects.workspaceId(synchronized))).resolves.toMatchObject({
      removed: true,
    });
    await expect(store.getRuntimeWorkspaceMapping("codex", "codex", "native-persistent")).resolves.toBeNull();
    await store.close();
  });

  it("reuses a registered parent Project for a nested Runtime Workspace", async () => {
    const { directory, store, projects } = await fixture();
    const projectRoot = await mkdtemp(join(directory, "project-"));
    const nestedRoot = join(projectRoot, "packages", "web");
    await mkdir(nestedRoot, { recursive: true });
    const registered = await projects.add(projectRoot);

    const result = await synchronizeRuntimeProjects({
      bindingId: "codex",
      runtimeKind: "codex",
      projects,
      stateStore: store,
      threads: [
        {
          runtimeThreadId: "thread-nested",
          name: "Nested",
          updatedAt: 1,
          workingDirectory: nestedRoot,
          workspaceIdentity: { key: "native-nested", kind: "persistent", localRoot: nestedRoot },
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.projectId).toBe(registered.projectId);
    await expect(store.getRuntimeWorkspaceMapping("codex", "codex", "native-nested")).resolves.toMatchObject({
      projectId: registered.projectId,
    });
    await store.close();
  });

  it("registers a global Project and resolves its runtime workspace", async () => {
    const { directory, store, projects } = await fixture();
    const root = await mkdtemp(join(directory, "root-"));

    const project = await projects.add(root);
    const workspace = await projects.resolveWorkspace(session({ projectId: project.projectId }));

    expect(project).toMatchObject({
      name: basename(await realpath(root)),
      rootPath: await realpath(root),
    });
    expect(workspace).toEqual({
      projectId: project.projectId,
      workingDirectory: await realpath(root),
      skipGitRepoCheck: true,
    });
    await store.close();
  });

  it("reuses the same canonical root but permits an explicitly registered nested Project", async () => {
    const { directory, store, projects } = await fixture();
    const root = await mkdtemp(join(directory, "root-"));
    const nested = join(root, "nested");
    await mkdir(nested);

    const first = await projects.ensureRegistered(root);
    const repeated = await projects.ensureRegistered(root);
    const nestedProject = await projects.ensureRegistered(nested);

    expect(first.created).toBe(true);
    expect(repeated).toEqual({ project: first.project, created: false });
    expect(nestedProject.created).toBe(true);
    expect(nestedProject.project.projectId).not.toBe(first.project.projectId);
    await expect(projects.findForWorkspace(nested)).resolves.toMatchObject({
      projectId: nestedProject.project.projectId,
    });
    await store.close();
  });

  it("creates a deterministic isolated workspace for a Non-Project Session", async () => {
    const { store, projects } = await fixture();
    const first = await projects.resolveWorkspace(session());
    const repeated = await projects.resolveWorkspace(session());
    const other = await projects.resolveWorkspace(session({ sessionId: "session-2" }));
    const otherBinding = await projects.resolveWorkspace(session({ agentId: "personal" }));

    expect(first).toEqual(repeated);
    expect(first.projectId).toBeNull();
    expect(first.skipGitRepoCheck).toBe(true);
    expect(first.workingDirectory).toStartWith(projects.workspaceRoot);
    expect(other.workingDirectory).not.toBe(first.workingDirectory);
    expect(otherBinding.workingDirectory).not.toBe(first.workingDirectory);
    expect((await stat(first.workingDirectory)).isDirectory()).toBe(true);
    await store.close();
  });

  it("uses paths validated at Project registration without probing them for every runtime turn", async () => {
    const { directory, store, projects } = await fixture();
    const root = await mkdtemp(join(directory, "registered-"));
    const project = await projects.add(root);
    await rm(root, { recursive: true });

    await expect(projects.resolveProjectWorkspace(project.projectId)).resolves.toEqual({
      projectId: project.projectId,
      workingDirectory: project.rootPath,
      skipGitRepoCheck: true,
    });
    await store.close();
  });

  it("removes only Projects that no Session references", async () => {
    const { directory, store, projects } = await fixture();
    const unusedRoot = await mkdtemp(join(directory, "unused-"));
    const usedRoot = await mkdtemp(join(directory, "used-"));
    const pendingRoot = await mkdtemp(join(directory, "pending-"));
    const unused = await projects.add(unusedRoot);
    const used = await projects.add(usedRoot);
    const pending = await projects.add(pendingRoot);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "work",
      projectId: used.projectId,
    });
    await store.setSessionIntent({
      chatId: "chat-2",
      agentId: "work",
      projectId: pending.projectId,
    });

    await expect(projects.remove(projects.workspaceId(unused))).resolves.toMatchObject({ removed: true });
    await expect(projects.remove(projects.workspaceId(used))).resolves.toMatchObject({
      removed: false,
      referencedSessions: 1,
    });
    await expect(projects.remove(projects.workspaceId(pending))).resolves.toMatchObject({
      removed: false,
      referencedSessions: 0,
      pendingIntents: 1,
    });
    await store.close();
  });

  it("rejects relative and duplicate Project roots", async () => {
    const { directory, store, projects } = await fixture();
    const root = await mkdtemp(join(directory, "root-"));
    await expect(projects.add("./repo")).rejects.toThrow("absolute path");
    await projects.add(root);
    await expect(projects.add(root)).rejects.toThrow("already registered");
    await store.close();
  });
});
