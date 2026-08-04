import { Banner } from "@astryxdesign/core/Banner";
import { useClientTranslator } from "../i18n/client-i18n";

export type UnsupportedBrowserReason = "sse" | "resizeObserver" | "randomUuid";

export function unsupportedBrowserReason(): UnsupportedBrowserReason | null {
  if (!("EventSource" in window)) return "sse";
  if (!("ResizeObserver" in window)) return "resizeObserver";
  if (!("randomUUID" in crypto)) return "randomUuid";
  return null;
}

export function UnsupportedBrowser({ reason }: { reason: UnsupportedBrowserReason }) {
  const t = useClientTranslator();
  return (
    <main className="unsupported-page">
      <Banner
        status="error"
        title={t("@connect.unsupported.title")}
        description={t("@connect.unsupported.description", { reason: t(`@connect.unsupported.${reason}`) })}
      />
    </main>
  );
}
