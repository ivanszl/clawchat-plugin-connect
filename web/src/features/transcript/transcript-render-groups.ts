import type { TranscriptBlock } from "../../../../src/client-contract";

export type ToolTranscriptBlock = Extract<TranscriptBlock, { type: "tool-call" | "command" | "file-change" }>;

export type TranscriptRenderEntry =
  | { kind: "block"; id: string; block: TranscriptBlock }
  | { kind: "tools"; id: string; blocks: ToolTranscriptBlock[] };

export function groupBlocksForRendering(blocks: TranscriptBlock[]): TranscriptRenderEntry[] {
  const entries: TranscriptRenderEntry[] = [];
  for (const block of blocks) {
    if (!isToolTranscriptBlock(block)) {
      entries.push({ kind: "block", id: block.id, block });
      continue;
    }
    const current = entries.at(-1);
    if (current?.kind === "tools") {
      current.blocks.push(block);
      current.id = `${current.blocks[0]?.id}:${block.id}`;
    } else {
      entries.push({ kind: "tools", id: block.id, blocks: [block] });
    }
  }
  return entries;
}

function isToolTranscriptBlock(block: TranscriptBlock): block is ToolTranscriptBlock {
  return block.type === "tool-call" || block.type === "command" || block.type === "file-change";
}
