import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeSendFileTarget } from "../src/agent/send-file-policy";
import { getConnectTool, recordToolInput, validateToolInput } from "../src/agent/tool-catalog";
import { executeConnectTool, MAX_SEND_FILE_BYTES } from "../src/agent/tool-executor";
import { EVENT } from "../src/clawchat/protocol";
import type { ConnectWsClient } from "../src/clawchat/ws-client";
import type { ActivationCredentials } from "../src/types";

const activation: ActivationCredentials = {
  localAgentId: "dsh",
  accessToken: "secret-token",
  refreshToken: null,
  serverAgentId: "agent-1",
  userId: "agent-user",
  ownerUserId: "owner-1",
  conversationId: "home",
};

interface SentPayload {
  message: { body: { fragments: Array<{ kind: string }> } };
}

async function setup(activeTurns: Array<{ chatId: string; speakerIds: string[] }> = []) {
  const root = await mkdtemp(join(tmpdir(), "send-file-"));
  const workspace = join(root, "ws");
  await mkdir(workspace);
  const outside = join(root, "outside");
  await mkdir(outside);
  const uploadMedia = mock(async (_file: Blob, options: { filename?: string }) => ({
    kind: "image" as const,
    url: "https://media.example/signed?sig=abc",
    name: options.filename ?? "x",
    mime: "image/png",
  }));
  const sendMessageEnvelope = mock(async () => ({ payload: { message_id: "out-1" } }));
  const wsClient = { uploadMedia, sendMessageEnvelope } as unknown as ConnectWsClient;
  const call = async (input: Record<string, unknown>) =>
    await executeConnectTool("clawchat_send_file", input, {
      baseUrl: "https://example.test",
      deviceId: "d",
      activation,
      wsClient,
      workspaceRoots: async () => [workspace],
      activeTurns: () => activeTurns,
    });
  return { workspace: await realpath(workspace), outside, uploadMedia, sendMessageEnvelope, call };
}

describe("clawchat_send_file", () => {
  it("has the Pi/ZeroClaw name and schema", () => {
    const tool = getConnectTool("clawchat_send_file");
    expect(tool?.properties.chat_id?.required).toBe(true);
    expect(tool?.properties.path?.required).toBe(true);
    expect(Object.keys(tool?.properties ?? {}).sort()).toEqual([
      "as_document",
      "caption",
      "chat_id",
      "chat_type",
      "path",
    ]);
    expect(() => validateToolInput(tool as never, { chat_id: "c", path: "/x", extra: 1 })).toThrow(
      "unknown input field",
    );
    expect(recordToolInput(tool as never, { chat_id: "c", path: "/ws/secret/dir/file.txt" }).path).toBe("file.txt");
  });

  it("uploads a Workspace file and sends one media message to the chat", async () => {
    const t = await setup();
    const path = join(t.workspace, "pic.png");
    await writeFile(path, "png");
    const result = await t.call({ chat_id: "cnv_1", path, caption: "here", chat_type: "group" });
    expect(result).toEqual({ sent: true, messageId: "out-1", name: "pic.png", size: 3 });
    expect(t.uploadMedia).toHaveBeenCalledTimes(1);
    const [event, chatId, payload, options] = t.sendMessageEnvelope.mock.calls[0] as unknown as [
      string,
      string,
      SentPayload,
      unknown,
    ];
    expect(event).toBe(EVENT.MESSAGE_SEND);
    expect(chatId).toBe("cnv_1");
    expect(options).toEqual({ toType: "group" });
    expect(payload.message.body.fragments.map((f) => f.kind)).toEqual(["text", "image"]);
    expect(JSON.stringify(result)).not.toContain("signed");
  });

  it("sends as a downloadable file when as_document is set", async () => {
    const t = await setup();
    const path = join(t.workspace, "pic.png");
    await writeFile(path, "png");
    await t.call({ chat_id: "cnv_1", path, as_document: true });
    const payload = (t.sendMessageEnvelope.mock.calls[0] as unknown as [string, string, SentPayload])[2];
    expect(payload.message.body.fragments.at(-1)?.kind).toBe("file");
  });

  it("confines paths to the Workspace and rejects symlink escapes", async () => {
    const t = await setup();
    const secret = join(t.outside, "secret.txt");
    await writeFile(secret, "s");
    await expect(t.call({ chat_id: "c", path: secret })).rejects.toThrow("outside the Workspace");
    await symlink(secret, join(t.workspace, "link.txt"));
    await expect(t.call({ chat_id: "c", path: join(t.workspace, "link.txt") })).rejects.toThrow(
      "outside the Workspace",
    );
    await symlink(t.outside, join(t.workspace, "dirlink"));
    await expect(t.call({ chat_id: "c", path: join(t.workspace, "dirlink", "secret.txt") })).rejects.toThrow(
      "outside the Workspace",
    );
    await expect(t.call({ chat_id: "c", path: join(t.workspace, "../ws/../outside/secret.txt") })).rejects.toThrow(
      "outside the Workspace",
    );
    await expect(t.call({ chat_id: "c", path: "relative.txt" })).rejects.toThrow("absolute");
    await expect(t.call({ chat_id: "c", path: join(t.workspace, "missing") })).rejects.toThrow("does not exist");
    expect(t.uploadMedia).not.toHaveBeenCalled();
  });

  it("refuses credential locations, directories and empty files", async () => {
    const t = await setup();
    await mkdir(join(t.workspace, ".ssh"));
    await writeFile(join(t.workspace, ".ssh", "id_rsa"), "k");
    await writeFile(join(t.workspace, ".env"), "k");
    await writeFile(join(t.workspace, "empty"), "");
    await expect(t.call({ chat_id: "c", path: join(t.workspace, ".ssh", "id_rsa") })).rejects.toThrow("credential");
    await expect(t.call({ chat_id: "c", path: join(t.workspace, ".env") })).rejects.toThrow("credential");
    await expect(t.call({ chat_id: "c", path: join(t.workspace, ".ssh") })).rejects.toThrow("credential");
    await expect(t.call({ chat_id: "c", path: t.workspace })).rejects.toThrow("regular file");
    await expect(t.call({ chat_id: "c", path: join(t.workspace, "empty") })).rejects.toThrow("empty");
    expect(t.uploadMedia).not.toHaveBeenCalled();
  });

  it("checks the 100 MiB limit before reading or uploading", async () => {
    const t = await setup();
    const exact = join(t.workspace, "exact.bin");
    await writeFile(exact, "");
    await truncate(exact, MAX_SEND_FILE_BYTES);
    await t.call({ chat_id: "c", path: exact });
    expect(t.uploadMedia).toHaveBeenCalledTimes(1);
    const over = join(t.workspace, "over.bin");
    await writeFile(over, "");
    await truncate(over, MAX_SEND_FILE_BYTES + 1);
    await expect(t.call({ chat_id: "c", path: over })).rejects.toThrow("100 MiB");
    expect(t.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it("limits a non-owner turn to its own chat and lets the owner reach other chats", async () => {
    const path = async (t: Awaited<ReturnType<typeof setup>>) => {
      const file = join(t.workspace, "a.txt");
      await writeFile(file, "a");
      return file;
    };
    const stranger = await setup([{ chatId: "chat-s", speakerIds: ["stranger"] }]);
    await expect(stranger.call({ chat_id: "chat-other", path: await path(stranger) })).rejects.toThrow(
      "Cross-conversation access is not allowed",
    );
    await stranger.call({ chat_id: "chat-s", path: await path(stranger) });
    expect(stranger.sendMessageEnvelope).toHaveBeenCalledTimes(1);

    const owner = await setup([{ chatId: "chat-o", speakerIds: ["owner-1"] }]);
    await owner.call({ chat_id: "chat-other", path: await path(owner) });
    expect(owner.sendMessageEnvelope).toHaveBeenCalledTimes(1);

    const local = await setup([]);
    await local.call({ chat_id: "chat-other", path: await path(local) });
    expect(local.sendMessageEnvelope).toHaveBeenCalledTimes(1);
  });

  it("denies another chat when a non-owner and the owner speak in a group batch", () => {
    expect(() =>
      authorizeSendFileTarget({
        chatId: "other",
        ownerUserId: "owner-1",
        activeTurns: [{ chatId: "g", speakerIds: ["owner-1", "friend"] }],
      }),
    ).toThrow("Cross-conversation");
    expect(() =>
      authorizeSendFileTarget({
        chatId: "g",
        ownerUserId: "owner-1",
        activeTurns: [{ chatId: "g", speakerIds: ["owner-1", "friend"] }],
      }),
    ).not.toThrow();
  });

  it("fails closed when no Workspace is configured", async () => {
    const t = await setup();
    await expect(
      executeConnectTool(
        "clawchat_send_file",
        { chat_id: "c", path: join(t.workspace, "a") },
        {
          baseUrl: "https://example.test",
          deviceId: "d",
          activation,
          wsClient: {} as ConnectWsClient,
        },
      ),
    ).rejects.toThrow("no Workspace");
  });
});
