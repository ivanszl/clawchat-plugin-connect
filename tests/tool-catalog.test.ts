import { describe, expect, it } from "bun:test";
import { CONNECT_TOOL_CATALOG, getConnectTool, validateToolInput } from "../src/agent/tool-catalog";

describe("Connect Tool Catalog", () => {
  it("publishes exactly the agreed 24 tool-name entries without memory or conversation lookup", () => {
    expect(CONNECT_TOOL_CATALOG).toHaveLength(24);
    expect(new Set(CONNECT_TOOL_CATALOG.map((tool) => tool.name)).size).toBe(24);
    expect(getConnectTool("clawchat_get_conversation")).toBeNull();
    expect(CONNECT_TOOL_CATALOG.some((tool) => tool.name.includes("memory"))).toBe(false);
    expect(
      CONNECT_TOOL_CATALOG.every(
        (tool) => ["http", "websocket", "file-upload"].includes(tool.execution) && typeof tool.handler === "function",
      ),
    ).toBe(true);
  });

  it("requires authoritative message and identity ids", () => {
    const reaction = getConnectTool("clawchat_react_message");
    if (!reaction) throw new Error("reaction tool missing");
    expect(() => validateToolInput(reaction, { chatId: "chat-1", chatType: "group", emoji: "👍" })).toThrow(
      "targetMessageId",
    );

    const mention = getConnectTool("clawchat_mention_message");
    if (!mention) throw new Error("mention tool missing");
    expect(() =>
      validateToolInput(mention, {
        chatId: "chat-1",
        mentions: [{ userId: "", display: "Alice" }],
      }),
    ).toThrow("userId");
  });
});
