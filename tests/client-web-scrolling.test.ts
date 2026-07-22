import { describe, expect, it } from "bun:test";

const viewportUrl = new URL("../web/src/features/transcript/TranscriptViewport.tsx", import.meta.url);

describe("Connect Client transcript scrolling", () => {
  it("jumps directly to the latest transcript block", async () => {
    const source = await Bun.file(viewportUrl).text();
    const jumpButton = source.slice(source.indexOf('label="跳到最新消息"'));

    expect(source).toContain('import { ChatLayoutScrollButton } from "@astryxdesign/core/Chat"');
    expect(source).toContain("<ChatLayoutScrollButton");
    expect(jumpButton).toContain('scrollToEnd({ behavior: "auto" })');
    expect(jumpButton).not.toContain('scrollToEnd({ behavior: "smooth" })');
  });
});
