import {
  InternationalizationContext,
  InternationalizationProvider,
  type TranslatorFn,
  useTranslator,
} from "@astryxdesign/core/i18n";
import { type ReactNode, use } from "react";
import { ClientInterfaceError } from "../client-interface/http";
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

export function useClientLocale(): ClientLocale {
  return use(InternationalizationContext).locale as ClientLocale;
}

const knownClientErrorKeys = {
  "client-warming-up": "@connect.error.clientWarmingUp",
  "binding-not-found": "@connect.error.bindingNotFound",
  "invalid-workspace": "@connect.error.invalidWorkspace",
  "invalid-name": "@connect.error.invalidName",
  "invalid-mode": "@connect.error.invalidMode",
  "invalid-model": "@connect.error.invalidModel",
  "invalid-reasoning-effort": "@connect.error.invalidReasoningEffort",
  "invalid-session-options": "@connect.error.invalidSessionOptions",
  "session-view-unavailable": "@connect.error.sessionViewUnavailable",
  "session-create-failed": "@connect.error.sessionCreateFailed",
  "session-not-found": "@connect.error.sessionNotFound",
  "session-state-conflict": "@connect.error.sessionStateConflict",
  "session-action-unsupported": "@connect.error.sessionActionUnsupported",
  "interaction-not-found": "@connect.error.interactionNotFound",
  "interaction-expired": "@connect.error.interactionExpired",
  "interaction-not-pending": "@connect.error.interactionNotPending",
  "invalid-interaction-response": "@connect.error.invalidInteractionResponse",
  "directory-not-found": "@connect.error.directoryNotFound",
  "directory-unavailable": "@connect.error.directoryUnavailable",
  "host-directory-unavailable": "@connect.error.directoryUnavailable",
  "directory-already-exists": "@connect.error.directoryAlreadyExists",
  "invalid-directory": "@connect.error.invalidDirectory",
  "invalid-directory-name": "@connect.error.invalidDirectoryName",
  "project-conflict": "@connect.error.projectConflict",
  "internal-error": "@connect.error.internal",
} as const satisfies Record<string, ClientMessageKey>;

export const settingsClientErrorKeys = {
  "binding-not-found": "@connect.settings.error.bindingNotFound",
  "invalid-model": "@connect.settings.error.invalidModel",
  "invalid-reasoning-effort": "@connect.settings.error.invalidReasoningEffort",
  "project-in-use": "@connect.settings.error.projectInUse",
  "project-not-found": "@connect.settings.error.projectNotFound",
  "project-conflict": "@connect.settings.error.projectConflict",
  "directory-not-found": "@connect.settings.error.directoryNotFound",
  "directory-unavailable": "@connect.settings.error.directoryUnavailable",
  "directory-already-exists": "@connect.settings.error.directoryAlreadyExists",
  "invalid-directory-name": "@connect.settings.error.invalidDirectoryName",
} as const satisfies Record<string, ClientMessageKey>;

type ClientErrorMessageKeys = Readonly<Partial<Record<string, ClientMessageKey>>>;

export function localizedClientError(
  t: ClientTranslator,
  error: unknown,
  featureKeys: ClientErrorMessageKeys = {},
): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ClientInterfaceError)) return raw;
  const key = featureKeys[error.code] ?? knownClientErrorKeys[error.code as keyof typeof knownClientErrorKeys];
  const message = key ? t(key, { detail: raw }) : raw;
  return error.diagnosticRef
    ? t("@connect.error.withDiagnostic", { message, diagnosticRef: error.diagnosticRef })
    : message;
}
