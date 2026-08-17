import astryxEnglish from "@astryxdesign/core/locales/en.json";
import type { ClientLocale } from "../client-locale";
import type { ClientCatalog } from "./en";
import { en } from "./en";
import { es } from "./es";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhHans } from "./zh-Hans";
import { zhHant } from "./zh-Hant";

function withAstryxFallback(catalog: ClientCatalog) {
  return { ...astryxEnglish, ...catalog };
}

export const clientMessages = {
  "zh-Hans": withAstryxFallback(zhHans),
  "zh-Hant": withAstryxFallback(zhHant),
  en: withAstryxFallback(en),
  ja: withAstryxFallback(ja),
  es: withAstryxFallback(es),
  ko: withAstryxFallback(ko),
} satisfies Record<ClientLocale, ClientCatalog>;
