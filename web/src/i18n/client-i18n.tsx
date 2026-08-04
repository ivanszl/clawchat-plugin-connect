import { InternationalizationProvider, type TranslatorFn, useTranslator } from "@astryxdesign/core/i18n";
import type { ReactNode } from "react";
import { clientMessages } from "./catalogs";
import type { ClientMessageKey } from "./catalogs/en";
import type { ClientLocale } from "./client-locale";

export type ClientTranslator = (key: ClientMessageKey, values?: Parameters<TranslatorFn>[1]) => string;

export function ClientInternationalizationProvider({
  locale,
  children,
}: {
  locale: ClientLocale;
  children: ReactNode;
}) {
  return (
    <InternationalizationProvider locale={locale} messages={clientMessages}>
      {children}
    </InternationalizationProvider>
  );
}

export function useClientTranslator(): ClientTranslator {
  return useTranslator() as ClientTranslator;
}
