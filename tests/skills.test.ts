import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installManagedSkills, preflightManagedSkills, verifyInstalledSkills } from "../src/skills";

describe("managed Agent skills", () => {
  it("rejects an invalid user Skill target before replacing managed files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-skills-preflight-"));
    const invalidParent = join(directory, "not-a-directory");
    await writeFile(invalidParent, "blocked");

    await expect(preflightManagedSkills({ targetRoot: join(invalidParent, "skills") })).rejects.toThrow();
    await expect(readFile(invalidParent, "utf8")).resolves.toBe("blocked");
  });

  it("force-overwrites edits and verifies the release manifest", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "clawchat-connect-skills-"));
    await installManagedSkills({ targetRoot });
    const skillPath = join(targetRoot, "clawchat-core", "SKILL.md");
    await writeFile(skillPath, "local edit", "utf8");
    await expect(verifyInstalledSkills({ targetRoot })).rejects.toThrow("changed or is missing");
    await installManagedSkills({ targetRoot });
    expect(await readFile(skillPath, "utf8")).toContain("clawchat-connect tool call");
    await expect(verifyInstalledSkills({ targetRoot })).resolves.toBeUndefined();
  });
});
