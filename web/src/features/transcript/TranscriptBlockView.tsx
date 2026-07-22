import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  type ChatToolCallStatus,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import type { EmbeddedTranscriptBlock, TranscriptBlock } from "../../../../src/client-contract";

export function TranscriptBlockView({
  block,
  isNested = false,
}: {
  block: TranscriptBlock | EmbeddedTranscriptBlock;
  isNested?: boolean;
}) {
  if (block.type === "message") {
    const sender = block.role === "user" ? "user" : "assistant";
    return (
      <ChatMessage sender={sender} density="balanced">
        <ChatMessageBubble
          variant={sender === "assistant" ? "ghost" : "filled"}
          name={block.author}
          metadata={
            <ChatMessageMetadata
              timestamp={!isNested && "updatedAt" in block ? formatTime(block.updatedAt) : undefined}
              footer={originLabel(block.origin)}
              status={block.state === "error" ? "error" : block.state === "pending" ? "sending" : undefined}
            />
          }
        >
          <SafeMarkdown markdown={block.markdown} isStreaming={block.state === "streaming"} />
        </ChatMessageBubble>
      </ChatMessage>
    );
  }
  if (block.type === "subagent") {
    return (
      <div className="runtime-block subagent-block">
        <Collapsible trigger={`子 Agent · ${block.title} · ${block.blocks.length} 项`} defaultIsOpen={false}>
          <div className="subagent-meta">
            {block.role ? <Badge variant="purple" label={block.role} /> : null}
            <Badge variant={block.state === "error" ? "error" : "neutral"} label={subagentStateLabel(block.state)} />
            <Text type="supporting">{subagentActivityLabel(block.activityKind)}</Text>
          </div>
          <div className="subagent-transcript">
            {block.blocks.length > 0 ? (
              block.blocks.map((child) => (
                <article className="subagent-transcript-item" data-block-type={child.type} key={child.id}>
                  <TranscriptBlockView block={child} isNested />
                </article>
              ))
            ) : (
              <Text type="supporting">这个子 Agent 没有可显示的历史。</Text>
            )}
          </div>
        </Collapsible>
      </div>
    );
  }
  if (block.type === "reasoning-summary" || block.type === "plan") {
    return (
      <div className="runtime-block reasoning-block">
        <Collapsible
          trigger={block.type === "plan" ? "执行计划" : "推理摘要"}
          defaultIsOpen={block.type === "plan" || block.state === "streaming"}
        >
          <SafeMarkdown markdown={block.markdown} isStreaming={block.state === "streaming"} />
        </Collapsible>
      </div>
    );
  }
  if (block.type === "tool-call") {
    return (
      <div className="runtime-block">
        <ChatToolCalls
          calls={[
            {
              key: block.id,
              name: block.title || "Tool call",
              status: toolStatus(block.status, block.state),
              resultDetail: block.detail ? (
                <CodeBlock code={block.detail} isWrapped hasCopyButton width="100%" size="sm" />
              ) : undefined,
            },
          ]}
        />
      </div>
    );
  }
  if (block.type === "command") {
    return (
      <div className="runtime-block">
        <ChatToolCalls
          calls={[
            {
              key: block.id,
              name: "Command",
              target: block.command,
              status: toolStatus(block.status, block.state),
              stats:
                block.exitCode == null ? undefined : (
                  <Badge variant={block.exitCode === 0 ? "success" : "error"} label={`exit ${block.exitCode}`} />
                ),
              resultDetail: (
                <CodeBlock
                  code={block.output || block.command}
                  language="shell"
                  title={block.command}
                  hasCopyButton
                  isWrapped
                  width="100%"
                  size="sm"
                />
              ),
            },
          ]}
        />
      </div>
    );
  }
  if (block.type === "file-change") {
    return (
      <div className="runtime-block">
        <ChatToolCalls
          label={`${block.files.length} 个文件变更`}
          calls={block.files.map((file, index) => ({
            key: `${block.id}:${index}`,
            name: file.kind || "File change",
            target: file.path,
            status: toolStatus(block.status, block.state),
            resultDetail: file.diff ? (
              <CodeBlock code={file.diff} language="diff" hasLineNumbers isWrapped width="100%" size="sm" />
            ) : undefined,
          }))}
        />
      </div>
    );
  }
  if (block.type === "error") {
    return (
      <div className="runtime-block">
        <Banner status="error" title={block.message} description={block.code} container="section" />
      </div>
    );
  }
  if (block.type === "runtime-interaction") {
    return (
      <div className="runtime-block">
        <Banner status="warning" title={block.title} description={block.description} container="section">
          <Text type="supporting">此版本仅展示 Runtime 交互；响应仍由 Connect 的受控通道处理。</Text>
        </Banner>
      </div>
    );
  }
  if (block.type === "usage") {
    return (
      <ChatSystemMessage>
        tokens: {block.inputTokens ?? "–"} in / {block.outputTokens ?? "–"} out
      </ChatSystemMessage>
    );
  }
  if (block.type === "progress") return <ChatSystemMessage>{block.label}</ChatSystemMessage>;
  return null;
}

function SafeMarkdown({ markdown, isStreaming }: { markdown: string; isStreaming: boolean }) {
  return (
    <Markdown
      headingLevelStart={3}
      isStreaming={isStreaming}
      autolink="gfm"
      contentWidth="72ch"
      onLinkClick={(href, event) => {
        if (!isSafeExternalLink(href)) {
          event.preventDefault();
          return false;
        }
        event.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
        return false;
      }}
      components={{
        image: ({ alt }) => <span className="blocked-image">[图片已阻止：{alt || "无描述"}]</span>,
        code: ({ code, language }) => (
          <CodeBlock code={code} language={language} hasCopyButton isWrapped width="100%" />
        ),
      }}
    >
      {markdown}
    </Markdown>
  );
}

function isSafeExternalLink(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function originLabel(origin: TranscriptBlock["origin"]): ReactNode {
  if (origin === "clawchat") return <Badge label="ClawChat" variant="teal" />;
  if (origin === "client") return <Badge label="Web" variant="blue" />;
  return undefined;
}

function toolStatus(status: string, state: TranscriptBlock["state"]): ChatToolCallStatus {
  if (state === "error" || /(?:fail|error|denied)/iu.test(status)) return "error";
  if (state === "pending") return "pending";
  if (state === "streaming" || /(?:running|progress)/iu.test(status)) return "running";
  return "complete";
}

function subagentStateLabel(state: TranscriptBlock["state"]): string {
  return {
    pending: "等待中",
    streaming: "运行中",
    complete: "已完成",
    error: "失败",
    cancelled: "已中止",
  }[state];
}

function subagentActivityLabel(activity: "started" | "interacted" | "interrupted" | "unknown"): string {
  return {
    started: "由主 Agent 启动",
    interacted: "与主 Agent 协作",
    interrupted: "被主 Agent 中止",
    unknown: "子 Agent 活动",
  }[activity];
}
