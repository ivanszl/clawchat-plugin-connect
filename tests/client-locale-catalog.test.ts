import { describe, expect, it } from "bun:test";
import { clientMessages } from "../web/src/i18n/catalogs";
import type { ClientMessageKey } from "../web/src/i18n/catalogs/en";
import { clientLocales } from "../web/src/i18n/client-locale";

describe("Connect Client locale catalogs", () => {
  it("keeps every locale aligned with the English source catalog and its ICU arguments", () => {
    expect(clientLocales).toEqual(["zh-Hans", "zh-Hant", "en", "ja", "es", "ko"]);
    const sourceKeys = (Object.keys(clientMessages.en) as ClientMessageKey[]).sort();
    expect(sourceKeys).toContain("@astryx.appShell.skipToContent");
    expect(Object.keys(clientMessages).sort()).toEqual([...clientLocales].sort());

    for (const locale of clientLocales) {
      const catalog = clientMessages[locale];
      expect(Object.keys(catalog).sort()).toEqual(sourceKeys);
      for (const key of sourceKeys) {
        expect(messageArguments(catalog[key].defaultMessage)).toEqual(
          messageArguments(clientMessages.en[key].defaultMessage),
        );
      }
    }
  });
});

function messageArguments(message: string): string[] {
  return [...message.matchAll(/\{\s*([a-z][a-z0-9_]*)\s*(?:,|\})/giu)].map((match) => match[1] ?? "").sort();
}
