import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, upsertAgent } from "../src/config";
import type { ConnectStateStore } from "../src/state";
import { registerClawChatToolsBestEffort } from "../src/tools/bridge";
import { createFileBackedMemoryPort, createMentionMessagePort } from "../src/tools/ports";
import { CLAWCHAT_TOOL_DEFINITIONS, executeClawChatTool } from "../src/tools/registry";
import { clawchatToolSchemas } from "../src/tools/schema";
import type { ConnectWsClient } from "../src/ws-client";

function makeStore(): ConnectStateStore {
  return {
    getActivation: mock(async () => ({
      localAgentId: "codex",
      accessToken: "token",
      refreshToken: null,
      serverAgentId: "agt",
      userId: "usr",
      ownerUserId: "owner",
      conversationId: "owner-chat",
    })),
    recordToolCall: mock(async () => undefined),
  } as unknown as ConnectStateStore;
}
function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "codex",
    config: upsertAgent(defaultConfig(), "codex", { kind: "acp", command: "codex" }),
    stateStore: makeStore(),
    ...overrides,
  };
}
const OPENCLAW_26_TOOL_NAMES = [
  "clawchat_get_account_profile",
  "clawchat_get_user_profile",
  "clawchat_list_account_friends",
  "clawchat_send_friend_request",
  "clawchat_list_friend_requests",
  "clawchat_accept_friend_request",
  "clawchat_reject_friend_request",
  "clawchat_remove_friend",
  "clawchat_search_users",
  "clawchat_get_conversation",
  "clawchat_mention_message",
  "clawchat_list_moments",
  "clawchat_create_moment",
  "clawchat_delete_moment",
  "clawchat_toggle_moment_reaction",
  "clawchat_create_moment_comment",
  "clawchat_reply_moment_comment",
  "clawchat_delete_moment_comment",
  "clawchat_update_account_profile",
  "clawchat_upload_avatar_image",
  "clawchat_memory_search",
  "clawchat_memory_read",
  "clawchat_memory_write",
  "clawchat_memory_edit",
  "clawchat_metadata_sync",
  "clawchat_metadata_update",
] as const;

describe("ClawChat tool registry", () => {
  it("contains exactly the OpenClaw/Hermes shared 26 tool names", () => {
    expect(CLAWCHAT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...OPENCLAW_26_TOOL_NAMES]);
    expect(CLAWCHAT_TOOL_DEFINITIONS).toHaveLength(26);
    for (const name of OPENCLAW_26_TOOL_NAMES) expect(clawchatToolSchemas[name]).toBeTruthy();
  });
  it("audits successful REST-backed tool calls", async () => {
    const api = { getMyProfile: mock(async () => ({ id: "me" })) };
    const stateStore = makeStore();
    const result = await executeClawChatTool("clawchat_get_account_profile", {}, makeContext({ api, stateStore }));
    expect(result).toMatchObject({ status: "ok", data: { id: "me" } });
    expect(stateStore.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "clawchat_get_account_profile", status: "ok" }),
    );
  });
  it("requires an absolute path for avatar upload", async () => {
    const result = await executeClawChatTool(
      "clawchat_upload_avatar_image",
      { filePath: "avatar.png" },
      makeContext({ api: {} }),
    );
    expect(result.status).toBe("error");
    expect(result.error?.kind).toBe("validation");
  });
  it("executes mention sends only through the required message port", async () => {
    const mentionMessage = { sendMentionMessage: mock(async () => ({ message_id: "msg-1" })) };
    const result = await executeClawChatTool(
      "clawchat_mention_message",
      { chatId: "chat-1", text: "hello", mentions: [{ userId: "usr-1", display: "Colin" }] },
      makeContext({ chatId: "chat-1", api: {}, mentionMessage }),
    );
    expect(result.status).toBe("ok");
    expect(mentionMessage.sendMentionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", mentions: [{ userId: "usr-1", display: "Colin" }] }),
    );
  });
  it("sends mention metadata through the message port", async () => {
    const wsClient = {
      sendMessageEnvelope: mock(async () => ({ payload: { message_id: "msg-1" } })),
    } as unknown as ConnectWsClient;
    const port = createMentionMessagePort(wsClient);
    await port.sendMentionMessage({
      chatId: "chat-1",
      chatType: "direct",
      text: "hello",
      mentions: [{ userId: "usr-1", display: "Colin" }],
      replyToMessageId: "msg-parent",
    });
    expect(wsClient.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.send",
      "chat-1",
      expect.objectContaining({
        message: expect.objectContaining({
          body: {
            fragments: [
              { kind: "mention", user_id: "usr-1", display: "Colin" },
              { kind: "text", text: " hello" },
            ],
          },
          context: expect.objectContaining({
            mentions: [{ user_id: "usr-1", display: "Colin" }],
            reply: expect.objectContaining({ reply_to_msg_id: "msg-parent" }),
          }),
        }),
      }),
      { toType: "direct" },
    );
  });
  it("searches file-backed memory and persists metadata updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawchat-connect-memory-"));
    const config = upsertAgent(defaultConfig(), "codex", { kind: "acp", command: "codex" });
    config.stateDbPath = join(dir, "state.sqlite");
    const memory = createFileBackedMemoryPort(config);
    await memory.write({ targetType: "owner", targetId: "owner", mode: "replace", content: "Colin likes cats" });
    await expect(memory.search({ query: "cats" })).resolves.toMatchObject({
      results: [expect.objectContaining({ targetType: "owner", targetId: "owner" })],
    });
    await memory.metadataUpdate({ targetType: "owner", targetId: "owner", patch: { nickname: "Colin" } });
    await expect(
      memory.metadataSync({ targetType: "owner", targetId: "owner", direction: "pull" }),
    ).resolves.toMatchObject({ metadata: expect.objectContaining({ nickname: "Colin" }) });
  });
  it("falls back visibly when ACP dynamic tool registration is unavailable", async () => {
    await expect(registerClawChatToolsBestEffort({}, makeContext())).resolves.toMatchObject({
      registered: false,
      reason: expect.stringContaining("stdio MCP"),
    });
  });
});
