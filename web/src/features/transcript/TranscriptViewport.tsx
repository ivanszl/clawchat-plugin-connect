import { ChatLayoutScrollButton } from "@astryxdesign/core/Chat";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SlashSuggestionView, TranscriptBlock, TranscriptPageView } from "../../../../src/client-contract";
import { ThreadIcon } from "../../components/icons";
import { useClientLocale, useClientTranslator } from "../../i18n/client-i18n";
import { TranscriptBlockView, TranscriptToolCallsView } from "./TranscriptBlockView";
import { groupBlocksForRendering, groupTranscriptBlocks, type TranscriptGroup } from "./transcript-render-groups";

export interface TranscriptViewportProps {
  sessionRef: string;
  pages: TranscriptPageView[];
  hasOlder: boolean;
  isLoadingOlder: boolean;
  slashSuggestions: SlashSuggestionView[];
  loadOlder(): Promise<unknown>;
  onOpenArtifact?: (path: string) => void;
}

export function TranscriptViewport({
  sessionRef,
  pages,
  hasOlder,
  isLoadingOlder,
  slashSuggestions,
  loadOlder,
  onOpenArtifact,
}: TranscriptViewportProps) {
  const locale = useClientLocale();
  const t = useClientTranslator();
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const followLatestRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const blocks = useMemo(() => mergePages(pages), [pages]);
  const groups = useMemo(() => groupTranscriptBlocks(blocks), [blocks]);
  const latestBlock = blocks.at(-1);
  const latestBlockRevision = latestBlock
    ? `${latestBlock.id}:${latestBlock.revision}:${latestBlock.state}:${latestBlock.plainText.length}`
    : null;
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => groups[index]?.id ?? index,
    estimateSize: (index) => estimateGroupSize(groups[index]),
    overscan: 7,
    anchorTo: "end",
    followOnAppend: false,
    scrollEndThreshold: 96,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0];
  const last = virtualItems.at(-1);
  const paddingBefore = Math.max(0, first?.start ?? 0);
  const paddingAfter = Math.max(0, virtualizer.getTotalSize() - (last?.end ?? 0));

  useLayoutEffect(() => {
    if (!latestBlockRevision || !followLatestRef.current) return;
    virtualizer.measure();
    let frame = 0;
    let frameCount = 0;
    let stableFrames = 0;
    const followLatest = () => {
      virtualizer.scrollToEnd({ behavior: "auto" });
      const element = scrollRef.current;
      const distance = element
        ? element.scrollHeight - element.clientHeight - element.scrollTop
        : Number.POSITIVE_INFINITY;
      stableFrames = distance <= 1 ? stableFrames + 1 : 0;
      frameCount += 1;
      if (stableFrames < 4 && frameCount < 60) frame = window.requestAnimationFrame(followLatest);
    };
    frame = window.requestAnimationFrame(followLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [latestBlockRevision, virtualizer]);

  useLayoutEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!followLatestRef.current) return;
      virtualizer.measure();
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (followLatestRef.current) virtualizer.scrollToEnd({ behavior: "auto" });
      });
    });
    observer.observe(column);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [virtualizer]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    followLatestRef.current = virtualizer.isAtEnd(160);
    setShowJump(!followLatestRef.current);
    if (element.scrollTop > 240 || !hasOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    void loadOlder().finally(() => {
      loadingOlderRef.current = false;
    });
  };

  if (blocks.length === 0) {
    return (
      <div className="transcript-empty">
        <EmptyState
          icon={<ThreadIcon className="empty-icon" />}
          title={t("@connect.transcript.empty.title")}
          description={t("@connect.transcript.empty.description")}
          isCompact
        />
      </div>
    );
  }

  return (
    <div className="transcript-frame">
      <div className="transcript-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="off">
        <div className="transcript-column" ref={columnRef}>
          {isLoadingOlder ? (
            <div className="older-loading">
              <Spinner size="sm" label={t("@connect.transcript.loadingOlder")} />
            </div>
          ) : null}
          <VirtualSpacer height={paddingBefore} />
          {virtualItems.map((item) => {
            const group = groups[item.index];
            if (!group) return null;
            return (
              <article
                className="transcript-item"
                data-index={item.index}
                data-transcript-group
                key={group.id}
                ref={virtualizer.measureElement}
              >
                <Divider className="transcript-group-divider" label={formatTranscriptDate(group.createdAt, locale)} />
                <div className="transcript-group-blocks">
                  {groupBlocksForRendering(group.blocks).map((entry) =>
                    entry.kind === "tools" ? (
                      <div className="transcript-group-block" data-block-type="tool-group" key={entry.id}>
                        <TranscriptToolCallsView blocks={entry.blocks} />
                      </div>
                    ) : (
                      <div className="transcript-group-block" data-block-type={entry.block.type} key={entry.id}>
                        <TranscriptBlockView
                          block={entry.block}
                          sessionRef={sessionRef}
                          onOpenArtifact={onOpenArtifact}
                          slashSuggestions={slashSuggestions}
                        />
                      </div>
                    ),
                  )}
                </div>
              </article>
            );
          })}
          <VirtualSpacer height={paddingAfter} />
        </div>
      </div>
      <ChatLayoutScrollButton
        className="jump-latest"
        isVisible={showJump}
        label={t("@connect.transcript.jumpToLatest")}
        onClick={() => {
          followLatestRef.current = true;
          setShowJump(false);
          virtualizer.scrollToEnd({ behavior: "auto" });
        }}
      />
    </div>
  );
}

function VirtualSpacer({ height }: { height: number }) {
  if (height < 1) return null;
  return <svg className="virtual-spacer" aria-hidden="true" width="1" height={Math.ceil(height)} />;
}

export function mergePages(pages: TranscriptPageView[]): TranscriptBlock[] {
  const byId = new Map<string, TranscriptBlock>();
  for (const page of [...pages].reverse()) {
    for (const block of page.blocks) {
      const current = byId.get(block.id);
      if (!current || current.revision <= block.revision) byId.set(block.id, block);
    }
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function formatTranscriptDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function estimateGroupSize(group: TranscriptGroup | undefined): number {
  if (!group) return 96;
  return 44 + group.blocks.reduce((height, block) => height + estimateBlockSize(block), 0);
}

function estimateBlockSize(block: TranscriptBlock | undefined): number {
  if (!block) return 96;
  const lines = Math.max(1, block.plainText.split("\n").length);
  if (block.type === "message") return Math.min(520, 72 + lines * 22);
  if (block.type === "subagent") return 92;
  if (block.type === "command" || block.type === "file-change") return 132;
  return Math.min(340, 54 + lines * 18);
}
