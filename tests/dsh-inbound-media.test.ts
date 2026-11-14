import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  return { workspace: await realpath(workspace), outside, source };
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
    const staged = await stageIntoWorkspaceInbox(workspace, "../msg/1", [
      { media: { kind: "file", url: "u", name: "a.txt", mime: "text/plain" }, sourcePath: source },
      { media: { kind: "file", url: "u", name: "A.txt", mime: "text/plain" }, sourcePath: source },
    ]);
    expect(staged.map((file) => file.name)).toEqual(["a.txt", "A-2.txt"]);
    expect(staged[0]?.path.startsWith(join(workspace, "clawchat-inbox"))).toBe(true);
    expect(await readdir(join(workspace, "clawchat-inbox"))).toEqual([".._msg_1".replace(/^\.+/u, "")]);
    expect(await readFile(staged[0]?.path as string, "utf8")).toBe("payload");
    const note = inboxPathNote(staged);
    expect(note).toContain(staged[0]?.path);
    expect(note).toContain("text/plain, 7 bytes");
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

  it("never writes through a planted symlink at the target name", async () => {
    const { workspace, outside, source } = await fixture();
    const dir = join(workspace, "clawchat-inbox", "m");
    await mkdir(dir, { recursive: true });
    await symlink(join(outside, "victim"), join(dir, "a.txt"));
    await expect(
      stageIntoWorkspaceInbox(workspace, "m", [
        { media: { kind: "file", url: "u", name: "a.txt" }, sourcePath: source },
      ]),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it("enforces count and size limits", async () => {
    const { workspace, source } = await fixture();
    const many = Array.from({ length: DSH_MAX_INBOUND_FILES + 1 }, (_, index) => ({
      media: { kind: "file" as const, url: "u", name: `${index}.txt` },
      sourcePath: source,
    }));
    await expect(stageIntoWorkspaceInbox(workspace, "m", many)).rejects.toThrow("at most");
    const big = join(workspace, "..", "big.bin");
    await writeFile(big, "");
    const { truncate } = await import("node:fs/promises");
    await truncate(big, DSH_MAX_INBOUND_FILE_BYTES + 1);
    await expect(
      stageIntoWorkspaceInbox(workspace, "m", [{ media: { kind: "video", url: "u", name: "v.mp4" }, sourcePath: big }]),
    ).rejects.toThrow("byte limit");
    expect(await readdir(join(workspace, "clawchat-inbox", "m"))).toEqual([]);
  });
});
