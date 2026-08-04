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
  if (typeof rawLanguage !== "string" || !isLanguageTagShape(rawLanguage)) return null;
  const [language, ...subtags] = rawLanguage.replaceAll("_", "-").toLowerCase().split("-");
  if (language === "zh") {
    if (subtags.includes("hant") || subtags.some((subtag) => ["tw", "hk", "mo"].includes(subtag))) {
      return "zh-Hant";
    }
    if (subtags.length === 0 || subtags.includes("hans") || subtags.some((subtag) => ["cn", "sg"].includes(subtag))) {
      return "zh-Hans";
    }
    return null;
  }
  if (language === "en" || language === "ja" || language === "es" || language === "ko") return language;
  return null;
}

function isLanguageTagShape(value: string): boolean {
  return /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/iu.test(value);
}
