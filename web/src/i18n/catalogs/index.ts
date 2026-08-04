import type { ClientLocale } from "../client-locale";
import type { ClientCatalog } from "./en";
import { en } from "./en";
import { es } from "./es";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhHans } from "./zh-Hans";
import { zhHant } from "./zh-Hant";

export const clientMessages = {
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  en,
  ja,
  es,
  ko,
} satisfies Record<ClientLocale, ClientCatalog>;
