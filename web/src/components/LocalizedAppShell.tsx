import { AppShell, type AppShellProps } from "@astryxdesign/core/AppShell";
import { useLayoutEffect } from "react";
import { useClientTranslator } from "../i18n/client-i18n";

export function LocalizedAppShell(props: AppShellProps) {
  const t = useClientTranslator();
  const skipToContent = t("@astryx.appShell.skipToContent");

  useLayoutEffect(() => {
    // Astryx 0.2.0 hard-codes this one accessible string instead of reading its provider.
    const skipLink = document.querySelector<HTMLElement>('[data-testid="skip-to-content"]');
    if (skipLink) skipLink.textContent = skipToContent;
  }, [skipToContent]);

  return <AppShell {...props} />;
}
