import { describe, expect, it, mock } from "bun:test";
import { executeConnectTool } from "../src/tool-executor";
import type { ActivationCredentials } from "../src/types";
import type { ConnectWsClient } from "../src/ws-client";

const activation: ActivationCredentials = {
  localAgentId: "codex",
  accessToken: "secret",
  refreshToken: null,
  serverAgentId: "agent-1",
  userId: "user-1",
  ownerUserId: "owner-1",
  conversationId: "chat-1",
};

describe("Connect Tool Executor", () => {
  it("sends message reactions on the existing binding WebSocket", async () => {
    const sendReaction = mock(() => undefined);
    const wsClient = { sendReaction } as unknown as ConnectWsClient;
    await expect(
      executeConnectTool(
        "clawchat_react_message",
        {
          chatId: "chat-1",
          targetMessageId: "message-1",
          emoji: "👍",
        },
        {
          baseUrl: "https://example.test",
          deviceId: "device-1",
          activation,
          wsClient,
        },
      ),
    ).resolves.toMatchObject({ reacted: true, targetMessageId: "message-1" });
    expect(sendReaction).toHaveBeenCalledWith("chat-1", "message-1", "👍", false);
  });

  it("uses authenticated REST without retrying a failed request", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({ code: 0, data: { users: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await executeConnectTool(
      "clawchat_search_users",
      { q: "Alice", limit: 5 },
      {
        baseUrl: "https://example.test/",
        deviceId: "device-1",
        activation,
        wsClient: {} as ConnectWsClient,
        fetchImpl,
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("https://example.test/v1/users/search?q=Alice&limit=5");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret",
      "x-device-id": "device-1",
    });
  });
});
