import { describe, expect, it } from "bun:test";

const stylesheetUrl = new URL("../web/src/styles/index.css", import.meta.url);
const sessionRouteUrl = new URL("../web/src/routes/sessions.$sessionRef.tsx", import.meta.url);
const iconsUrl = new URL("../web/src/components/icons.tsx", import.meta.url);
const appShellUrl = new URL("../web/src/features/app-shell/ConnectAppShell.tsx", import.meta.url);

describe("Connect Client session layout", () => {
  it("keeps the transcript and composer in stable rows when the history warning is absent", async () => {
    const stylesheet = await Bun.file(stylesheetUrl).text();

    expect(cssRule(stylesheet, ".session-notices")).toContain("grid-row: 2");
    expect(cssRule(stylesheet, ".transcript-frame")).toContain("grid-row: 3");
    expect(cssRule(stylesheet, ".composer-region")).toContain("grid-row: 4");
  });

  it("keeps model settings out of the Session header and inside the composer", async () => {
    const source = await Bun.file(sessionRouteUrl).text();
    const header = source.slice(source.indexOf('<header className="session-header">'), source.indexOf("</header>"));

    expect(header).not.toContain("<SessionModelControls");
    expect(source).toContain("modelControl={<SessionModelControls view={view} />}");
    expect(source).toContain('label="Session 模型设置"');
    expect(source).toContain('placement="above"');
  });

  it("places Session workspace metadata below the primary title", async () => {
    const source = await Bun.file(sessionRouteUrl).text();
    const heading = source.slice(
      source.indexOf('<div className="session-heading">'),
      source.indexOf('<div className="session-meta">'),
    );

    expect(heading.indexOf("<h1")).toBeLessThan(heading.indexOf('<p className="session-eyebrow">'));
  });

  it("uses the Astryx-recommended Lucide icon instead of a hand-drawn settings glyph", async () => {
    const [icons, appShell] = await Promise.all([Bun.file(iconsUrl).text(), Bun.file(appShellUrl).text()]);

    expect(icons).not.toContain("export function SettingsIcon");
    expect(appShell).toContain('import { Icon } from "@astryxdesign/core/Icon"');
    expect(appShell).toContain('import { Settings } from "lucide-react"');
    expect(appShell).toContain("icon={<Icon icon={Settings}");
  });
});

function cssRule(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) return "";
  const openingBrace = stylesheet.indexOf("{", start);
  const closingBrace = stylesheet.indexOf("}", openingBrace);
  return stylesheet.slice(openingBrace + 1, closingBrace);
}
