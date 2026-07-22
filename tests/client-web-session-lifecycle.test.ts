import { describe, expect, it } from "bun:test";

const sessionRouteUrl = new URL("../web/src/routes/sessions.$sessionRef.tsx", import.meta.url);
const navigationUrl = new URL("../web/src/features/session-catalog/SessionNavigation.tsx", import.meta.url);

describe("Connect Client Session lifecycle", () => {
  it("uses Astryx actions and a destructive confirmation for native lifecycle commands", async () => {
    const source = await Bun.file(sessionRouteUrl).text();

    expect(source).toContain('import { AlertDialog } from "@astryxdesign/core/AlertDialog"');
    expect(source).toContain('import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"');
    expect(source).toContain('lifecycle.mutate("archive")');
    expect(source).toContain('lifecycle.mutate("unarchive")');
    expect(source).toContain('lifecycle.mutate("delete"');
    expect(source).toContain("SubAgent Thread 不会被 Connect 额外级联删除");
    expect(source).not.toContain("window.confirm");
  });

  it("keeps archived Sessions in their own collapsed navigation group", async () => {
    const source = await Bun.file(navigationUrl).text();

    expect(source).toContain("const archived = visible.filter((entry) => entry.isArchived)");
    expect(source).toContain("id: `archived:" + "$" + "{binding.bindingId}`");
    expect(source).toContain('label: "已归档"');
  });
});
