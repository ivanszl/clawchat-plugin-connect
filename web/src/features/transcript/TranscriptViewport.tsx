import { ChatLayoutScrollButton } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptBlock, TranscriptPageView } from "../../../../src/client-contract";
import { ThreadIcon } from "../../components/icons";
import { TranscriptBlockView } from "./TranscriptBlockView";

export interface TranscriptViewportProps {
  pages: TranscriptPageView[];
  hasOlder: boolean;
  isLoadingOlder: boolean;
  loadOlder(): Promise<unknown>;
}

export function TranscriptViewport({ pages, hasOlder, isLoadingOlder, loadOlder }: TranscriptViewportProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const blocks = useMemo(() => mergePages(pages), [pages]);
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => blocks[index]?.id ?? index,
    estimateSize: (index) => estimateBlockSize(blocks[index]),
    overscan: 7,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 96,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0];
  const last = virtualItems.at(-1);
  const paddingBefore = Math.max(0, first?.start ?? 0);
  const paddingAfter = Math.max(0, virtualizer.getTotalSize() - (last?.end ?? 0));

  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    setShowJump(!virtualizer.isAtEnd(160));
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
          title="这个 Session 还没有消息"
          description="在下方输入消息，Connect 会把它直接发送给绑定的 Agent。"
          isCompact
        />
      </div>
    );
  }

  return (
    <div className="transcript-frame">
      <div className="transcript-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="off">
        <div className="transcript-column">
          {isLoadingOlder ? (
            <div className="older-loading">
              <Spinner size="sm" label="正在载入更早的消息" />
            </div>
          ) : null}
          <VirtualSpacer height={paddingBefore} />
          {virtualItems.map((item) => {
            const block = blocks[item.index];
            if (!block) return null;
            return (
              <article
                className="transcript-item"
                data-index={item.index}
                data-block-type={block.type}
                key={block.id}
                ref={virtualizer.measureElement}
              >
                <TranscriptBlockView block={block} />
              </article>
            );
          })}
          <VirtualSpacer height={paddingAfter} />
        </div>
      </div>
      <ChatLayoutScrollButton
        className="jump-latest"
        isVisible={showJump}
        label="跳到最新消息"
        onClick={() => virtualizer.scrollToEnd({ behavior: "auto" })}
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

function estimateBlockSize(block: TranscriptBlock | undefined): number {
  if (!block) return 96;
  const lines = Math.max(1, block.plainText.split("\n").length);
  if (block.type === "message") return Math.min(520, 72 + lines * 22);
  if (block.type === "subagent") return 92;
  if (block.type === "command" || block.type === "file-change") return 132;
  return Math.min(340, 54 + lines * 18);
}
