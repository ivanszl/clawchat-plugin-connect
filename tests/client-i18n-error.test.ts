import { expect, test } from "bun:test";
import type { TranslatorFn } from "@astryxdesign/core/i18n";
import { ClientInterfaceError } from "../web/src/client-interface/http";
import type { ClientMessageKey } from "../web/src/i18n/catalogs/en";
// @ts-expect-error The service tsconfig intentionally has no JSX; Bun loads the production locale helper for this seam.
import { localizedClientError } from "../web/src/i18n/client-i18n";

test("localizes a warming startup failure by stable code", () => {
  const error = new ClientInterfaceError(
    503,
    "client-warming-up",
    "Connect Client is still initializing",
    true,
    "startup-diag-1",
  );
  const t = (key: ClientMessageKey, values?: Parameters<TranslatorFn>[1]) =>
    key === "@connect.error.withDiagnostic" ? `${String(values?.message)} [${String(values?.diagnosticRef)}]` : key;

  expect(localizedClientError(t, error)).toBe("@connect.error.clientWarmingUp [startup-diag-1]");
});

test("uses a feature-specific stable-code message while preserving server detail", () => {
  const error = new ClientInterfaceError(409, "workspace-in-use", "Workspace alpha is used by Session beta", false);
  const t = (key: ClientMessageKey, values?: Parameters<TranslatorFn>[1]) =>
    key === "@connect.settings.error.workspaceInUse" ? `Localized: ${values?.detail}` : key;

  expect(localizedClientError(t, error, { "workspace-in-use": "@connect.settings.error.workspaceInUse" })).toBe(
    "Localized: Workspace alpha is used by Session beta",
  );
});
