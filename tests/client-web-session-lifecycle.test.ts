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
    expect(source).toContain('t("@connect.session.delete.description")');
    expect(source).toContain("localizedClientError(t, lifecycle.error)");
    expect(source).not.toContain("window.confirm");
  });

  it("localizes the complete new-Session dialog without changing technical choices", async () => {
    const source = await Bun.file(navigationUrl).text();

    expect(source).toContain('t("@connect.newSession.title")');
    expect(source).toContain('t("@connect.newSession.project.nonProject")');
    expect(source).toContain('t("@connect.newSession.mode.default")');
    expect(source).toContain('t("@connect.newSession.model.default")');
    expect(source).toContain('t("@connect.newSession.reasoning.label")');
    expect(source).toContain("localizedClientError(t, create.error)");
    expect(source).toContain("label: value");
    expect(source).toContain(["label: `", "$", "{option.displayName} (", "$", "{option.id})`"].join(""));
  });

  it("keeps archived Sessions in their own collapsed navigation group", async () => {
    const source = await Bun.file(navigationUrl).text();

    expect(source).toContain("const archived = visible.filter((entry) => entry.isArchived)");
    expect(source).toContain("id: `archived:" + "$" + "{binding.bindingId}`");
    expect(source).toContain('label: t("@connect.navigation.archived", { count: archived.length })');
  });

  it("keeps Session Refs out of navigation rows and shows status dots only for active work", async () => {
    const source = await Bun.file(navigationUrl).text();
    const itemSource = source.slice(
      source.indexOf("function sessionItem("),
      source.indexOf("\nfunction sessionStatus("),
    );

    expect(itemSource).not.toContain("description:");
    expect(itemSource).toContain("endContent: status ? (");
    expect(itemSource).toContain("<StatusDot");
    expect(source).toContain(
      'if (entry.isArchived || entry.status === "idle" || entry.status === "offline") return null',
    );
    expect(source).toContain(
      'running: { variant: "success", label: t("@connect.navigation.status.running"), isPulsing: true }',
    );
    expect(source).toContain('queued: { variant: "warning", label: t("@connect.navigation.status.queued") }');
  });
});
