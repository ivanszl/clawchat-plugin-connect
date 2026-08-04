import { isStructurallySame, parse } from "@formatjs/icu-messageformat-parser";
import { clientMessages } from "../web/src/i18n/catalogs";
import type { ClientMessageKey } from "../web/src/i18n/catalogs/en";
import { clientLocales } from "../web/src/i18n/client-locale";

const expectedLocales = ["zh-Hans", "zh-Hant", "en", "ja", "es", "ko"] as const;
assertSameValues("locale mapping", Object.keys(clientMessages), expectedLocales);
assertSameValues("canonical locales", clientLocales, expectedLocales);

const sourceKeys = Object.keys(clientMessages.en) as ClientMessageKey[];
for (const locale of clientLocales) {
  const catalog = clientMessages[locale];
  assertSameValues(`${locale} catalog keys`, Object.keys(catalog), sourceKeys);
  for (const key of sourceKeys) {
    const sourceMessage = clientMessages.en[key].defaultMessage;
    const localizedMessage = catalog[key].defaultMessage;
    const match = isStructurallySame(parse(sourceMessage), parse(localizedMessage));
    if (!match.success) {
      throw new Error(`${locale} message ${key} is structurally incompatible with English: ${match.error?.message}`);
    }
  }
}

const exercisedAstryxKeys = await astryxKeysInBuiltClient();
const missingAstryxKeys = exercisedAstryxKeys.filter((key) => !(key in clientMessages.en));
if (missingAstryxKeys.length > 0) {
  throw new Error(`English catalog is missing exercised Astryx messages:\n${missingAstryxKeys.join("\n")}`);
}

process.stdout.write(
  `Verified ${sourceKeys.length} locale messages across ${clientLocales.length} locales and ${exercisedAstryxKeys.length} exercised Astryx keys.\n`,
);

async function astryxKeysInBuiltClient(): Promise<string[]> {
  const keys = new Set<string>();
  let sourceMapCount = 0;
  const glob = new Bun.Glob("dist/client/assets/*.js.map");
  for await (const path of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
    sourceMapCount += 1;
    const map = (await Bun.file(path).json()) as { sources?: string[]; sourcesContent?: Array<string | null> };
    for (const [index, sourcePath] of (map.sources ?? []).entries()) {
      if (sourcePath.includes("/locales/") || sourcePath.includes("/i18n/resolve")) continue;
      const source = map.sourcesContent?.[index] ?? "";
      for (const match of source.matchAll(/@astryx\.[A-Za-z0-9_.-]+/gu)) {
        const key = match[0];
        if (!key.endsWith(".")) keys.add(key);
      }
    }
  }
  if (sourceMapCount === 0) throw new Error("No built Client source maps found; run `bun run build:web` first");
  return [...keys].sort();
}

function assertSameValues(label: string, actual: readonly string[], expected: readonly string[]): void {
  const actualValues = [...actual].sort();
  const expectedValues = [...expected].sort();
  if (actualValues.length !== expectedValues.length || actualValues.some((value, index) => value !== expectedValues[index])) {
    throw new Error(`${label} mismatch:\nexpected ${expectedValues.join(", ")}\nreceived ${actualValues.join(", ")}`);
  }
}
