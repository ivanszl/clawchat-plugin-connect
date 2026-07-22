import { Banner } from "@astryxdesign/core/Banner";

export function unsupportedBrowserReason(): string | null {
  if (!("EventSource" in window)) return "当前浏览器不支持 Server-Sent Events。";
  if (!("ResizeObserver" in window)) return "当前浏览器不支持动态消息测量。";
  if (!("randomUUID" in crypto)) return "当前浏览器缺少安全的请求标识支持。";
  return null;
}

export function UnsupportedBrowser({ reason }: { reason: string }) {
  return (
    <main className="unsupported-page">
      <Banner
        status="error"
        title="无法运行 Connect Client"
        description={`${reason} 请升级到最新版本的 Chrome、Edge、Firefox 或 Safari。`}
      />
    </main>
  );
}
