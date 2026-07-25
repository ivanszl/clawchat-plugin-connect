import { describe, expect, it } from "bun:test";

const stylesheetUrl = new URL("../web/src/styles/index.css", import.meta.url);
const sessionRouteUrl = new URL("../web/src/routes/sessions.$sessionRef.tsx", import.meta.url);
const iconsUrl = new URL("../web/src/components/icons.tsx", import.meta.url);

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

  it("uses a gear glyph for the settings action rather than a theme sun", async () => {
    const source = await Bun.file(iconsUrl).text();
    const settingsIcon = source.slice(
      source.indexOf("export function SettingsIcon"),
      source.indexOf("\nexport function RefreshIcon"),
    );

    expect(settingsIcon).toContain('d="M10 2h4');
    expect(settingsIcon).not.toContain("M12 2v3");
  });
});

function cssRule(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) return "";
  const openingBrace = stylesheet.indexOf("{", start);
  const closingBrace = stylesheet.indexOf("}", openingBrace);
  return stylesheet.slice(openingBrace + 1, closingBrace);
}
