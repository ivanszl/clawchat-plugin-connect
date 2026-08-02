import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatTokenizedText,
  type ChatToolCallItem,
  type ChatToolCallStatus,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type {
  EmbeddedTranscriptBlock,
  RuntimeInteractionBlock,
  SlashSuggestionView,
  TranscriptBlock,
} from "../../../../src/client-contract";
import { normalizeWorkspaceArtifactHref, workspaceArtifactUrl } from "../../../../src/workspace-artifact";
import { respondToRuntimeInteraction } from "../../client-interface/query-options";
import { leadingSlashSuggestion, slashSuggestionToken } from "../slash-suggestions";

export function TranscriptBlockView({
  block,
  sessionRef,
  onOpenArtifact,
  slashSuggestions = [],
}: {
  block: TranscriptBlock | EmbeddedTranscriptBlock;
  sessionRef: string;
  onOpenArtifact?: (path: string) => void;
  slashSuggestions?: SlashSuggestionView[];
}) {
  if (block.type === "message") {
    const sender = block.role === "user" ? "user" : "assistant";
    const markdown = visibleMessageMarkdown(block);
    const selectedSlash = sender === "user" ? leadingSlashSuggestion(markdown, slashSuggestions) : null;
    return (
      <ChatMessage sender={sender} density="balanced">
        <ChatMessageBubble
          variant={sender === "assistant" ? "ghost" : "filled"}
          name={messageAuthorLabel(block)}
          metadata={
            <ChatMessageMetadata
              footer={originLabel(block.origin)}
              status={block.state === "error" ? "error" : block.state === "pending" ? "sending" : undefined}
            />
          }
        >
          {block.media?.map((media) =>
            media.kind === "image" ? (
              <a href={media.url} target="_blank" rel="noreferrer" key={media.url}>
                <img
                  className="clawchat-message-image"
                  src={media.url}
                  alt={media.name || "ClawChat 图片"}
                  width={media.width ?? undefined}
                  height={media.height ?? undefined}
                  loading="lazy"
                />
              </a>
            ) : null,
          )}
          {markdown ? (
            selectedSlash ? (
              <ChatTokenizedText
                className="transcript-message-tokenized"
                tokens={[slashSuggestionToken(selectedSlash)]}
              >
                {markdown}
              </ChatTokenizedText>
            ) : (
              <SafeMarkdown
                markdown={markdown}
                isStreaming={block.state === "streaming"}
                preserveLineBreaks
                sessionRef={sessionRef}
                onOpenArtifact={onOpenArtifact}
              />
            )
          ) : null}
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
                  <TranscriptBlockView
                    block={child}
                    sessionRef={sessionRef}
                    onOpenArtifact={onOpenArtifact}
                    slashSuggestions={slashSuggestions}
                  />
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
          <SafeMarkdown
            markdown={block.markdown}
            isStreaming={block.state === "streaming"}
            sessionRef={sessionRef}
            onOpenArtifact={onOpenArtifact}
          />
        </Collapsible>
      </div>
    );
  }
  if (block.type === "tool-call") {
    return <TranscriptToolCallsView blocks={[block]} />;
  }
  if (block.type === "command") {
    return <TranscriptToolCallsView blocks={[block]} />;
  }
  if (block.type === "file-change") {
    return <TranscriptToolCallsView blocks={[block]} />;
  }
  if (block.type === "error") {
    return (
      <div className="runtime-block">
        <Banner status="error" title={block.message} description={block.code} container="section" />
      </div>
    );
  }
  if (block.type === "runtime-interaction") {
    return <RuntimeInteractionForm block={block as RuntimeInteractionBlock} />;
  }
  if (block.type === "usage") {
    return (
      <ChatSystemMessage>
        tokens: {block.inputTokens ?? "–"} in / {block.outputTokens ?? "–"} out
      </ChatSystemMessage>
    );
  }
  if (block.type === "progress") return <ChatSystemMessage>{block.label}</ChatSystemMessage>;
  return (
    <div className="runtime-block unknown-block">
      <ChatToolCalls
        defaultIsExpanded={false}
        calls={[
          {
            key: block.id,
            name: block.label || "Runtime activity",
            status: toolStatus(block.state, block.state),
            resultDetail: block.detail ? (
              <CodeBlock code={block.detail} isWrapped hasCopyButton width="100%" size="sm" />
            ) : undefined,
          },
        ]}
      />
    </div>
  );
}

export type ToolTranscriptBlock = Extract<
  TranscriptBlock | EmbeddedTranscriptBlock,
  { type: "tool-call" | "command" | "file-change" }
>;

export function TranscriptToolCallsView({ blocks }: { blocks: ToolTranscriptBlock[] }) {
  const calls = blocks.flatMap(toolCallsForBlock);
  return (
    <div className="runtime-block runtime-tool-calls">
      <ChatToolCalls calls={calls} defaultIsExpanded={false} />
    </div>
  );
}

function toolCallsForBlock(block: ToolTranscriptBlock): ChatToolCallItem[] {
  if (block.type === "tool-call") {
    return [
      {
        key: block.id,
        name: block.title || "Tool call",
        status: toolStatus(block.status, block.state),
        resultDetail: block.detail ? (
          <CodeBlock code={block.detail} isWrapped hasCopyButton width="100%" size="sm" />
        ) : undefined,
      },
    ];
  }
  if (block.type === "command") {
    return [
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
    ];
  }
  return block.files.map((file) => {
    const changes = diffStats(file.diff);
    return {
      key: `${block.id}:${file.path}`,
      name: file.kind || "File change",
      target: file.path,
      status: toolStatus(block.status, block.state),
      additions: changes.additions || undefined,
      deletions: changes.deletions || undefined,
      resultDetail: file.diff ? (
        <CodeBlock code={file.diff} language="diff" hasLineNumbers isWrapped width="100%" size="sm" />
      ) : undefined,
    };
  });
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function RuntimeInteractionForm({ block }: { block: RuntimeInteractionBlock }) {
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [remainingMs, setRemainingMs] = useState(() => deadlineRemaining(block.autoResolutionAt));
  useEffect(() => {
    setRemainingMs(deadlineRemaining(block.autoResolutionAt));
    if (!block.autoResolutionAt || block.responseState !== "pending") return;
    const timer = window.setInterval(() => setRemainingMs(deadlineRemaining(block.autoResolutionAt)), 1_000);
    return () => window.clearInterval(timer);
  }, [block.autoResolutionAt, block.responseState]);
  const submit = useMutation({
    mutationFn: async (payload: { optionId?: string; answers?: Record<string, string[]> }) =>
      await respondToRuntimeInteraction(block.interactionId, payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["client"] }),
  });
  const pending = block.responseState === "pending";
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submit.isPending || !pending) return;
    submit.mutate({
      answers: Object.fromEntries(
        block.questions.map((question) => [question.id, [(answers[question.id] ?? "").replace(/^__other__:/u, "")]]),
      ),
    });
  };
  return (
    <div className="runtime-block runtime-interaction-card">
      <Banner
        status={pending ? "warning" : block.responseState === "resolved" ? "success" : "info"}
        title={block.title}
        description={block.description}
        container="section"
        defaultIsExpanded={pending}
      >
        {block.command ? <CodeBlock code={block.command} language="shell" isWrapped width="100%" /> : null}
        {block.cwd ? <Text type="supporting">工作目录：{block.cwd}</Text> : null}
        {pending && remainingMs !== null ? (
          <Text type="supporting">剩余 {Math.max(0, Math.ceil(remainingMs / 1_000))} 秒</Text>
        ) : null}
        {block.files.map((file) => (
          <div key={file.path}>
            <Text type="supporting">{file.path}</Text>
            {file.diff ? <CodeBlock code={file.diff} language="diff" isWrapped width="100%" /> : null}
          </div>
        ))}
        {pending && block.interactionType === "approval" ? (
          <div className="runtime-interaction-actions">
            {block.options.map((option) => (
              <button
                type="button"
                key={option.id}
                disabled={submit.isPending}
                className={option.id === "deny" ? "interaction-button danger" : "interaction-button"}
                onClick={() => submit.mutate({ optionId: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        {pending && block.interactionType === "user-input" ? (
          <form className="runtime-interaction-form" onSubmit={onSubmit}>
            {block.questions.map((question) => (
              <fieldset key={question.id}>
                <legend>{question.header}</legend>
                <Text type="supporting">{question.prompt}</Text>
                {question.options ? (
                  <div className="runtime-interaction-options">
                    {question.options.map((option) => (
                      <label key={option.id}>
                        <input
                          required
                          type="radio"
                          name={question.id}
                          value={option.label}
                          checked={answers[question.id] === option.label}
                          onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                        />
                        <span>
                          {option.label}
                          {option.description ? <small>{option.description}</small> : null}
                        </span>
                      </label>
                    ))}
                    {question.allowOther ? (
                      <label>
                        <input
                          required
                          type="radio"
                          name={question.id}
                          value="__other__"
                          checked={answers[question.id]?.startsWith("__other__:") === true}
                          onChange={() => setAnswers((current) => ({ ...current, [question.id]: "__other__:" }))}
                        />
                        <span>其他</span>
                        <input
                          aria-label={`${question.header}的其他回答`}
                          type={question.secret ? "password" : "text"}
                          disabled={!answers[question.id]?.startsWith("__other__:")}
                          required={answers[question.id]?.startsWith("__other__:")}
                          value={answers[question.id]?.replace(/^__other__:/u, "") ?? ""}
                          onChange={(event) =>
                            setAnswers((current) => ({
                              ...current,
                              [question.id]: `__other__:${event.target.value}`,
                            }))
                          }
                        />
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <input
                    aria-label={question.header}
                    required
                    type={question.secret ? "password" : "text"}
                    autoComplete={question.secret ? "off" : undefined}
                    value={answers[question.id] ?? ""}
                    onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                  />
                )}
              </fieldset>
            ))}
            <button className="interaction-button" type="submit" disabled={submit.isPending}>
              提交回答
            </button>
          </form>
        ) : null}
        {!pending ? (
          <Text type="supporting">
            {block.responseState === "resolved" ? "已处理" : "此请求已过期"}
            {block.resolvedBy ? ` · ${block.resolvedBy === "client" ? "Web" : block.resolvedBy}` : ""}
          </Text>
        ) : null}
        {submit.isError ? <Text type="supporting">{submit.error.message}</Text> : null}
      </Banner>
    </div>
  );
}

function deadlineRemaining(deadline: string | null): number | null {
  if (!deadline) return null;
  const timestamp = Date.parse(deadline);
  return Number.isFinite(timestamp) ? timestamp - Date.now() : null;
}

function SafeMarkdown({
  markdown,
  isStreaming,
  sessionRef,
  onOpenArtifact,
  preserveLineBreaks = false,
}: {
  markdown: string;
  isStreaming: boolean;
  sessionRef: string;
  onOpenArtifact?: (path: string) => void;
  preserveLineBreaks?: boolean;
}) {
  return (
    <Markdown
      className={preserveLineBreaks ? "transcript-message-markdown" : undefined}
      headingLevelStart={3}
      isStreaming={isStreaming}
      autolink="gfm"
      contentWidth="72ch"
      components={{
        image: ({ alt }) => <span className="blocked-image">[图片已阻止：{alt || "无描述"}]</span>,
        link: ({ href, children }) => (
          <SafeMarkdownLink href={href} sessionRef={sessionRef} onOpenArtifact={onOpenArtifact}>
            {children}
          </SafeMarkdownLink>
        ),
        code: ({ code, language }) => (
          <CodeBlock code={code} language={language} hasCopyButton isWrapped width="100%" />
        ),
      }}
    >
      {routeStandaloneImagesThroughOverride(markdown)}
    </Markdown>
  );
}

function SafeMarkdownLink({
  href,
  sessionRef,
  onOpenArtifact,
  children,
}: {
  href: string;
  sessionRef: string;
  onOpenArtifact?: (path: string) => void;
  children: ReactNode;
}) {
  const localPath = normalizeWorkspaceArtifactHref(href);
  if (localPath) {
    return (
      <a
        href={workspaceArtifactUrl(sessionRef, localPath)}
        onClick={
          onOpenArtifact
            ? (event) => {
                event.preventDefault();
                onOpenArtifact(localPath);
              }
            : undefined
        }
      >
        {children}
      </a>
    );
  }
  if (!isSafeExternalLink(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function routeStandaloneImagesThroughOverride(markdown: string): string {
  let fenceCharacter: "`" | "~" | null = null;
  let fenceLength = 0;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
      if (fenceCharacter) {
        if (
          fence?.[0] === fenceCharacter &&
          fence.length >= fenceLength &&
          line.slice(line.indexOf(fence) + fence.length).trim() === ""
        ) {
          fenceCharacter = null;
          fenceLength = 0;
        }
        return line;
      }
      if (fence) {
        fenceCharacter = fence[0] as "`" | "~";
        fenceLength = fence.length;
        return line;
      }
      const standaloneImage = /^((?:(?: {0,3}>[ \t]?)+)?[ \t]*)(!\[[^\]\r\n]*\]\([^\r\n]*\))[ \t]*$/u.exec(line);
      if (!standaloneImage) return line;
      const prefix = standaloneImage[1] ?? "";
      if (!prefix.includes(">") && (prefix.startsWith("\t") || prefix.length >= 4)) return line;
      // Astryx 0.1.7 skips components.image for a block consisting only of an image.
      // A word joiner keeps the node inline so the Connect-owned safe image renderer runs.
      return `${prefix}\u2060${line.slice(prefix.length)}`;
    })
    .join("\n");
}

function visibleMessageMarkdown(
  block: Extract<TranscriptBlock | EmbeddedTranscriptBlock, { type: "message" }>,
): string {
  if (!block.media?.length) return block.markdown;
  const withoutMediaPlaceholders = block.markdown.replace(/\[(?:image|file|audio|video)(?:: [^\]]+)?\]/giu, "").trim();
  return withoutMediaPlaceholders;
}

function isSafeExternalLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function originLabel(origin: TranscriptBlock["origin"]): ReactNode {
  if (origin === "clawchat") return <Badge label="ClawChat" variant="teal" />;
  if (origin === "client") return <Badge label="Web" variant="blue" />;
  return undefined;
}

function messageAuthorLabel(block: TranscriptBlock | EmbeddedTranscriptBlock): string | undefined {
  if (block.type !== "message" || block.role !== "user") return undefined;
  if (block.origin === "clawchat") return block.sender?.displayName || undefined;
  return block.author;
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
