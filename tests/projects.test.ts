import { describe, expect, it } from "bun:test";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCatalog } from "../src/projects";
import { createStateStore } from "../src/state";
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
    agentId: "work",
    runtimeSessionId: null,
    projectId: null,
    name: null,
    mode: null,
    isCurrent: true,
    updatedAt: 1,
    ...overrides,
  };
}

describe("ProjectCatalog", () => {
  it("registers a global Project and resolves its runtime workspace", async () => {
    const { directory, store, projects } = await fixture();
    const root = await mkdtemp(join(directory, "root-"));
    const additional = await mkdtemp(join(directory, "shared-"));

    const project = await projects.add("work", root, [additional]);
    const workspace = await projects.resolveWorkspace(session({ projectId: project.projectId }));

    expect(project).toMatchObject({
      name: "work",
      rootPath: await realpath(root),
      additionalDirectories: [await realpath(additional)],
    });
    expect(workspace).toEqual({
      projectId: project.projectId,
      workingDirectory: await realpath(root),
      additionalDirectories: [await realpath(additional)],
      skipGitRepoCheck: true,
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

  it("removes only Projects that no Session references", async () => {
    const { directory, store, projects } = await fixture();
    const unusedRoot = await mkdtemp(join(directory, "unused-"));
    const usedRoot = await mkdtemp(join(directory, "used-"));
    const unused = await projects.add("unused", unusedRoot);
    const used = await projects.add("used", usedRoot);
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "work",
      projectId: used.projectId,
    });

    await expect(projects.remove(unused.projectId)).resolves.toMatchObject({ removed: true });
    await expect(projects.remove(used.projectId)).resolves.toMatchObject({
      removed: false,
      referencedSessions: 1,
    });
    await store.close();
  });

  it("rejects relative and duplicate Project roots", async () => {
    const { directory, store, projects } = await fixture();
    const root = await mkdtemp(join(directory, "root-"));
    await expect(projects.add("relative", "./repo")).rejects.toThrow("absolute path");
    await projects.add("first", root);
    await expect(projects.add("second", root)).rejects.toThrow("already registered");
    await store.close();
  });
});
