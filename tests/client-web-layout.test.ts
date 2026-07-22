import { describe, expect, it } from "bun:test";

const stylesheetUrl = new URL("../web/src/styles/index.css", import.meta.url);

describe("Connect Client session layout", () => {
  it("keeps the transcript and composer in stable rows when the history warning is absent", async () => {
    const stylesheet = await Bun.file(stylesheetUrl).text();

    expect(cssRule(stylesheet, ".session-notices")).toContain("grid-row: 2");
    expect(cssRule(stylesheet, ".transcript-frame")).toContain("grid-row: 3");
    expect(cssRule(stylesheet, ".composer-region")).toContain("grid-row: 4");
  });
});

function cssRule(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) return "";
  const openingBrace = stylesheet.indexOf("{", start);
  const closingBrace = stylesheet.indexOf("}", openingBrace);
  return stylesheet.slice(openingBrace + 1, closingBrace);
}
