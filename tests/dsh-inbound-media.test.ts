import { describe, expect, it } from "bun:test";
import {
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DSH_INBOX_PRUNE_BATCH,
  DSH_INBOX_RETENTION_MS,
  DSH_MAX_INBOUND_FILE_BYTES,
  DSH_MAX_INBOUND_FILES,
  inboxPathNote,
  sanitizeInboxName,
  stageIntoWorkspaceInbox,
} from "../src/runtime/dsh-inbound-media";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-inbox-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  const source = join(root, "source.bin");
  await writeFile(source, "payload");
  return { root, workspace: await realpath(workspace), outside, source };
}

describe("DSH inbound media staging", () => {
  it("sanitizes hostile names to one safe segment", () => {
    expect(sanitizeInboxName("../../etc/passwd", "file", undefined)).toBe("passwd");
    expect(sanitizeInboxName("C:\\Users\\x\\..\\secret.txt", "file", undefined)).toBe("secret.txt");
    expect(sanitizeInboxName("..", "file", undefined)).toBe("file");
    expect(sanitizeInboxName(".hidden", "file", undefined)).toBe("hidden");
    expect(sanitizeInboxName("a\nb\u0000c$(x).txt", "file", undefined)).toBe("abc__x_.txt");
    expect(sanitizeInboxName(undefined, "audio", "audio/mp4")).toBe("audio.m4a");
    expect(Buffer.byteLength(sanitizeInboxName(`${"长".repeat(200)}.pdf`, "file", undefined))).toBeLessThanOrEqual(120);
  });

  it("copies into <workspace>/clawchat-inbox/<message-id>/ with unique names and a path note", async () => {
    const { workspace, source } = await fixture();
    const { staged, dropped } = await stageIntoWorkspaceInbox(workspace, "../msg/1", [
      { media: { kind: "file", url: "u", name: "a.txt", mime: "text/plain" }, sourcePath: source },
      { media: { kind: "file", url: "u", name: "A.txt", mime: "text/plain" }, sourcePath: source },
    ]);
    expect(dropped).toEqual([]);
    expect(staged.map((file) => file.name)).toEqual(["a.txt", "A-2.txt"]);
    expect(staged[0]?.path.startsWith(join(workspace, "clawchat-inbox"))).toBe(true);
    expect(await readdir(join(workspace, "clawchat-inbox"))).toEqual(["_msg_1"]);
    expect(await readFile(staged[0]?.path as string, "utf8")).toBe("payload");
    const note = inboxPathNote(staged, [{ name: "big.mp4", reason: "larger than 100 MiB" }]);
    expect(note).toContain(staged[0]?.path);
    expect(note).toContain("text/plain, 7 bytes");
    expect(note).toContain("big.mp4 was not received: larger than 100 MiB");
  });

  it("refuses an inbox that is a symlink out of the Workspace", async () => {
    const { workspace, outside, source } = await fixture();
    await symlink(outside, join(workspace, "clawchat-inbox"));
    await expect(
      stageIntoWorkspaceInbox(workspace, "m", [
        { media: { kind: "file", url: "u", name: "a.txt" }, sourcePath: source },
      ]),
    ).rejects.toThrow("not a plain directory");
    expect(await readdir(outside)).toEqual([]);
  });

  it("never writes through a planted symlink at the target name and picks another name", async () => {
    const { workspace, outside, source } = await fixture();
    const dir = join(workspace, "clawchat-inbox", "m");
    await mkdir(dir, { recursive: true });
    await symlink(join(outside, "victim"), join(dir, "a.txt"));
    const { staged } = await stageIntoWorkspaceInbox(workspace, "m", [
      { media: { kind: "file", url: "u", name: "a.txt" }, sourcePath: source },
    ]);
    expect(staged.map((file) => file.name)).toEqual(["a-2.txt"]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("reuses an identical file on redelivery and suffixes a different one", async () => {
    const { workspace, root, source } = await fixture();
    const item = { media: { kind: "file" as const, url: "u", name: "a.txt" }, sourcePath: source };
    const first = await stageIntoWorkspaceInbox(workspace, "m", [item]);
    const second = await stageIntoWorkspaceInbox(workspace, "m", [item]);
    expect(second.dropped).toEqual([]);
    expect(second.staged[0]?.path).toBe(first.staged[0]?.path);
    const other = join(root, "other.bin");
    await writeFile(other, "different!");
    const third = await stageIntoWorkspaceInbox(workspace, "m", [{ ...item, sourcePath: other }]);
    expect(third.staged[0]?.name).toBe("a-2.txt");
    expect((await readdir(join(workspace, "clawchat-inbox", "m"))).sort()).toEqual(["a-2.txt", "a.txt"]);
  });

  it("drops one oversized or surplus attachment without failing the rest", async () => {
    const { workspace, source, root } = await fixture();
    const big = join(root, "big.bin");
    await writeFile(big, "");
    await truncate(big, DSH_MAX_INBOUND_FILE_BYTES + 1);
    const result = await stageIntoWorkspaceInbox(workspace, "m", [
      { media: { kind: "video", url: "u", name: "v.mp4" }, sourcePath: big },
      { media: { kind: "file", url: "u", name: "ok.txt" }, sourcePath: source },
      { media: { kind: "file", url: "u", name: "missing.txt" }, sourcePath: join(root, "gone") },
    ]);
    expect(result.staged.map((file) => file.name)).toEqual(["ok.txt"]);
    expect(result.dropped).toEqual([
      { name: "v.mp4", reason: "larger than 100 MiB" },
      { name: "missing.txt", reason: "could not be saved" },
    ]);
    const many = Array.from({ length: DSH_MAX_INBOUND_FILES + 2 }, (_, index) => ({
      media: { kind: "file" as const, url: "u", name: `n${index}.txt` },
      sourcePath: source,
    }));
    const limited = await stageIntoWorkspaceInbox(workspace, "m2", many);
    expect(limited.staged).toHaveLength(DSH_MAX_INBOUND_FILES);
    expect(limited.dropped).toHaveLength(2);
    expect(limited.dropped[0]?.reason).toContain("more than");
  });

  describe("retention", () => {
    const old = (ms = DSH_INBOX_RETENTION_MS + 86_400_000) => new Date(Date.now() - ms);
    async function aged(inbox: string, name: string, when: Date, files = ["f.txt"]) {
      const dir = join(inbox, name);
      await mkdir(dir, { recursive: true });
      for (const file of files) {
        await writeFile(join(dir, file), "x");
        await utimes(join(dir, file), when, when);
      }
      await utimes(dir, when, when);
    }
    const stage = async (workspace: string, source: string, turn = "current") =>
      await stageIntoWorkspaceInbox(workspace, turn, [
        { media: { kind: "file", url: "u", name: "n.txt" }, sourcePath: source },
      ]);

    it("removes turn directories whose newest entry is older than 30 days and keeps recent or current ones", async () => {
      const { workspace, source } = await fixture();
      const inbox = join(workspace, "clawchat-inbox");
      await aged(inbox, "stale", old());
      await aged(inbox, "mixed", old(), ["a.txt", "b.txt"]);
      await utimes(join(inbox, "mixed", "b.txt"), new Date(), new Date());
      await aged(inbox, "recent", old(DSH_INBOX_RETENTION_MS - 86_400_000));
      await aged(inbox, "current", old());
      await stage(workspace, source);
      expect((await readdir(inbox)).sort()).toEqual(["current", "mixed", "recent"]);
    });

    it("never follows symlinks and never touches anything outside the inbox", async () => {
      const { workspace, outside, source } = await fixture();
      const inbox = join(workspace, "clawchat-inbox");
      await mkdir(inbox);
      await writeFile(join(outside, "keep.txt"), "x");
      await utimes(join(outside, "keep.txt"), old(), old());
      await utimes(outside, old(), old());
      await symlink(outside, join(inbox, "linked"));
      await writeFile(join(inbox, "loose-file"), "x");
      await utimes(join(inbox, "loose-file"), old(), old());
      await aged(inbox, "withlink", old());
      await symlink(outside, join(inbox, "withlink", "escape"));
      await lutimes(join(inbox, "withlink", "escape"), old(), old());
      await utimes(join(inbox, "withlink"), old(), old());
      await stage(workspace, source);
      expect(await readdir(outside)).toEqual(["keep.txt"]);
      const left = await readdir(inbox);
      expect(left).toContain("linked");
      expect(left).toContain("loose-file");
      expect(left).not.toContain("withlink");
    });

    it("does nothing when the inbox itself is not a real directory", async () => {
      const { workspace, outside, source } = await fixture();
      await aged(outside, "stale", old());
      await symlink(outside, join(workspace, "clawchat-inbox"));
      await expect(stage(workspace, source)).rejects.toThrow("not a plain directory");
      expect(await readdir(outside)).toEqual(["stale"]);
    });

    it("caps the work per call and never fails staging on cleanup errors", async () => {
      const { workspace, source } = await fixture();
      const inbox = join(workspace, "clawchat-inbox");
      for (let index = 0; index < DSH_INBOX_PRUNE_BATCH + 5; index += 1) await aged(inbox, `s${index}`, old());
      const result = await stage(workspace, source);
      expect(result.staged).toHaveLength(1);
      expect((await readdir(inbox)).filter((name) => name.startsWith("s"))).toHaveLength(5);
    });
  });
});
