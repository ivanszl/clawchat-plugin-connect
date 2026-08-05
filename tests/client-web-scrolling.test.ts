import { describe, expect, it } from "bun:test";
import type { TranscriptBlock } from "../src/client-contract";
import {
  groupBlocksForRendering,
  groupTranscriptBlocks,
} from "../web/src/features/transcript/transcript-render-groups";

const viewportUrl = new URL("../web/src/features/transcript/TranscriptViewport.tsx", import.meta.url);

describe("Connect Client transcript scrolling", () => {
  it("jumps directly to the latest transcript block", async () => {
    const source = await Bun.file(viewportUrl).text();
    const jumpButton = source.slice(source.indexOf("<ChatLayoutScrollButton"));

    expect(source).toContain('import { ChatLayoutScrollButton } from "@astryxdesign/core/Chat"');
    expect(source).toContain("<ChatLayoutScrollButton");
    expect(jumpButton).not.toContain('label={t("@connect.transcript.jumpToLatest")}');
    expect(jumpButton).toContain('scrollToEnd({ behavior: "auto" })');
    expect(jumpButton).not.toContain('scrollToEnd({ behavior: "smooth" })');
  });

  it("keeps following when rendered transcript content changes height", async () => {
    const source = await Bun.file(viewportUrl).text();

    expect(source).toContain("new ResizeObserver");
    expect(source).toContain("followLatestRef.current");
    expect(source).toContain('scrollToEnd({ behavior: "auto" })');
  });

  it("passes consecutive Runtime tools to one Astryx ChatToolCalls group", () => {
    const blocks = [
      transcriptBlock("tool-1", "tool-call"),
      transcriptBlock("command-1", "command"),
      transcriptBlock("files-1", "file-change"),
      transcriptBlock("message-1", "message"),
      transcriptBlock("tool-2", "tool-call"),
    ];

    const entries = groupBlocksForRendering(blocks);

    expect(entries.map((entry) => entry.kind)).toEqual(["tools", "block", "tools"]);
    expect(entries[0]?.kind === "tools" ? entries[0].blocks.map((block) => block.id) : []).toEqual([
      "tool-1",
      "command-1",
      "files-1",
    ]);
  });

  it("keeps the active Turn DOM key stable while folded tool output streams in", () => {
    const user = transcriptBlock("user-1", "message");
    const firstTool = transcriptBlock("tool-1", "tool-call");
    const initialGroup = groupTranscriptBlocks([user, firstTool])[0];
    const updatedGroup = groupTranscriptBlocks([
      user,
      { ...firstTool, revision: 2 },
      transcriptBlock("tool-2", "tool-call"),
    ])[0];

    expect(initialGroup?.id).toBe("user-1");
    expect(updatedGroup?.id).toBe(initialGroup?.id);
  });
});

function transcriptBlock(id: string, type: TranscriptBlock["type"]): TranscriptBlock {
  const base = {
    id,
    type,
    origin: "runtime" as const,
    state: "complete" as const,
    plainText: "",
    revision: 1,
    sequence: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
  if (type === "tool-call") return { ...base, type, title: "update", status: "complete", detail: "" };
  if (type === "command") return { ...base, type, command: "git status", output: "", status: "complete", exitCode: 0 };
  if (type === "file-change") return { ...base, type, status: "complete", files: [] };
  return {
    ...base,
    type: "message",
    role: id.startsWith("user-") ? "user" : "assistant",
    author: id.startsWith("user-") ? "User" : "Agent",
    markdown: "",
  };
}
