export const clientLocales = ["zh-Hans", "zh-Hant", "en", "ja", "es", "ko"] as const;

export type ClientLocale = (typeof clientLocales)[number];

export function resolveClientLocale(rawLanguage: unknown, browserLanguages: readonly string[]): ClientLocale {
  const queryLocale = canonicalClientLocale(rawLanguage);
  if (queryLocale) return queryLocale;

  for (const browserLanguage of browserLanguages) {
    const browserLocale = canonicalClientLocale(browserLanguage);
    if (browserLocale) return browserLocale;
  }
  return "en";
}

export function canonicalClientLocale(rawLanguage: unknown): ClientLocale | null {
  if (typeof rawLanguage !== "string") return null;
  const subtags = parseLanguageTag(rawLanguage);
  if (!subtags) return null;
  const [language, ...rest] = subtags;
  if (language === "zh") {
    if (rest.includes("hant") || rest.some((subtag) => ["tw", "hk", "mo"].includes(subtag))) {
      return "zh-Hant";
    }
    if (rest.length === 0 || rest.includes("hans") || rest.some((subtag) => ["cn", "sg"].includes(subtag))) {
      return "zh-Hans";
    }
    return null;
  }
  if (language === "en" || language === "ja" || language === "es" || language === "ko") return language;
  return null;
}

function parseLanguageTag(value: string): string[] | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(value.replaceAll("_", "-"));
    return canonical?.toLowerCase().split("-") ?? null;
  } catch {
    return null;
  }
}
