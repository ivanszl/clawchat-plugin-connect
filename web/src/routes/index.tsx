import { EmptyState } from "@astryxdesign/core/EmptyState";
import { createFileRoute } from "@tanstack/react-router";
import { ThreadIcon } from "../components/icons";

export const Route = createFileRoute("/")({ component: ConnectHome });

function ConnectHome() {
  return (
    <section className="home-page">
      <div className="home-grid" aria-hidden="true" />
      <EmptyState
        headingLevel={1}
        icon={<ThreadIcon className="empty-icon" />}
        title="选择一个 Session"
        description="左侧会列出该 Connect 绑定可发现的所有 Project 和 Non-Project Session。"
      />
      <p className="home-note">网页消息只进入 Connect 绑定的 Agent，不会同步回 ClawChat。</p>
    </section>
  );
}
