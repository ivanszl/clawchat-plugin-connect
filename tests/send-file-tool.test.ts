import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActiveClawChatTurn, authorizeSendFileTarget } from "../src/agent/send-file-policy";
import { getConnectTool, recordToolInput, validateToolInput } from "../src/agent/tool-catalog";
import { executeConnectTool, MAX_SEND_FILE_BYTES } from "../src/agent/tool-executor";
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

const ownerTurn = (chatId = "chat-o", chatType: "direct" | "group" = "direct"): ActiveClawChatTurn => ({
  chatId,
  chatType,
  speakerIds: ["owner-1"],
});
const strangerTurn = (chatId = "chat-s", chatType: "direct" | "group" = "direct"): ActiveClawChatTurn => ({
  chatId,
  chatType,
  speakerIds: ["stranger"],
});

const originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

async function setup(activeTurns: ActiveClawChatTurn[] = [ownerTurn()], layout: "workspace" | "home" = "workspace") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "send-file-")));
  const workspace = layout === "home" ? root : join(root, "ws");
  if (layout === "workspace") await mkdir(workspace);
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  const sendMediaMessage = mock(async (..._args: unknown[]) => ({ payload: { message_id: "out-1" } }));
  const wsClient = { sendMediaMessage } as unknown as ConnectWsClient;
  const call = async (input: Record<string, unknown>, extra: { secretRoots?: string[] } = {}) =>
    await executeConnectTool("clawchat_send_file", input, {
      baseUrl: "https://example.test",
      deviceId: "d",
      activation,
      wsClient,
      workspaceRoots: async () => [workspace],
      activeTurns: () => activeTurns,
      ...(extra.secretRoots ? { secretRoots: () => extra.secretRoots as string[] } : {}),
    });
  return { root, workspace, outside, sendMediaMessage, call };
}

async function file(dir: string, name: string, content = "a"): Promise<string> {
  const path = join(dir, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
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

  it("sends one media message through sendMediaMessage with caption, document flag and known chat type", async () => {
    const t = await setup([ownerTurn("cnv_g", "group")]);
    const path = await file(t.workspace, "pic.png", "png");
    const result = await t.call({ chat_id: "cnv_g", path, caption: "here", as_document: true });
    expect(result).toEqual({ sent: true, messageId: "out-1", name: "pic.png", size: 3 });
    const [chatId, uploads, options] = t.sendMediaMessage.mock.calls[0] as unknown as [
      string,
      Array<{ filename: string }>,
      Record<string, unknown>,
    ];
    expect(chatId).toBe("cnv_g");
    expect(uploads.map((upload) => upload.filename)).toEqual(["pic.png"]);
    expect(options).toEqual({ text: "here", asDocument: true, toType: "group" });
    expect(JSON.stringify(result)).not.toContain("signed");
  });

  it("derives chat_type from the running turn, falls back to direct, and rejects a mismatch", async () => {
    const t = await setup([ownerTurn("chat-g", "group")]);
    const path = await file(t.workspace, "a.txt");
    await t.call({ chat_id: "chat-g", path });
    expect((t.sendMediaMessage.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({ toType: "group" });
    await expect(t.call({ chat_id: "chat-g", path, chat_type: "direct" })).rejects.toThrow("does not match");
    await t.call({ chat_id: "chat-unknown", path });
    expect((t.sendMediaMessage.mock.calls[1] as unknown as unknown[])[2]).toMatchObject({ toType: "direct" });
    await t.call({ chat_id: "chat-unknown", path, chat_type: "group" });
    expect((t.sendMediaMessage.mock.calls[2] as unknown as unknown[])[2]).toMatchObject({ toType: "group" });
  });

  it("confines paths to the Workspace and rejects symlink escapes", async () => {
    const t = await setup();
    const secret = await file(t.outside, "secret.txt");
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
    await expect(t.call({ chat_id: "c", path: t.workspace })).rejects.toThrow("outside the Workspace");
    await expect(t.call({ chat_id: "c", path: "relative.txt" })).rejects.toThrow("absolute");
    await expect(t.call({ chat_id: "c", path: join(t.workspace, "missing") })).rejects.toThrow("does not exist");
    expect(t.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("refuses credential files regardless of workspace, matching case-insensitively", async () => {
    const t = await setup();
    const denied = [
      ".ssh/id_rsa",
      ".SSH/config",
      ".aws/credentials",
      ".gnupg/pubring.kbx",
      ".kube/config",
      ".docker/config.json",
      ".config/gh/hosts.yml",
      ".git-credentials",
      ".netrc",
      ".npmrc",
      ".pypirc",
      "certs/server.PEM",
      "certs/server.key",
      "keys/id_ed25519",
      ".env",
      ".env.production",
    ];
    for (const name of denied) {
      await expect(t.call({ chat_id: "c", path: await file(t.workspace, name) })).rejects.toThrow("credential");
    }
    expect(t.sendMediaMessage).not.toHaveBeenCalled();
    await expect(t.call({ chat_id: "c", path: join(t.workspace, ".ssh") })).rejects.toThrow("credential");
  });

  it("refuses the Connect home and DSH state directories even inside the Workspace", async () => {
    const t = await setup([ownerTurn()], "home");
    process.env.HOME = t.root;
    for (const dir of [".clawchat-connect", ".dsh", ".deepseek", ".clawchat-dsh"]) {
      await expect(t.call({ chat_id: "c", path: await file(t.root, `${dir}/state.db`) })).rejects.toThrow(
        "state directory",
      );
    }
    const configured = join(t.root, "custom-dsh-home");
    await expect(
      t.call({ chat_id: "c", path: await file(configured, "x") }, { secretRoots: [configured] }),
    ).rejects.toThrow("state directory");
    expect(t.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("refuses hidden files and a home-directory Workspace when another sender is speaking", async () => {
    const t = await setup([strangerTurn("chat-s")]);
    await expect(t.call({ chat_id: "chat-s", path: await file(t.workspace, ".hidden/notes.txt") })).rejects.toThrow(
      "hidden",
    );
    await expect(t.call({ chat_id: "chat-s", path: await file(t.workspace, ".draft") })).rejects.toThrow("hidden");
    await t.call({ chat_id: "chat-s", path: await file(t.workspace, "visible.txt") });
    expect(t.sendMediaMessage).toHaveBeenCalledTimes(1);

    const owner = await setup([ownerTurn("chat-o")]);
    await owner.call({ chat_id: "chat-o", path: await file(owner.workspace, ".hidden/notes.txt") });
    expect(owner.sendMediaMessage).toHaveBeenCalledTimes(1);

    const home = await setup([strangerTurn("chat-s")], "home");
    process.env.HOME = home.root;
    await expect(home.call({ chat_id: "chat-s", path: await file(home.root, "doc.txt") })).rejects.toThrow(
      "home directory",
    );
    expect(home.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("refuses directories and empty files, and checks the 100 MiB limit before sending", async () => {
    const t = await setup();
    await expect(t.call({ chat_id: "c", path: await file(t.workspace, "empty", "") })).rejects.toThrow("empty");
    await mkdir(join(t.workspace, "dir"));
    await expect(t.call({ chat_id: "c", path: join(t.workspace, "dir") })).rejects.toThrow("regular file");
    const exact = await file(t.workspace, "exact.bin", "");
    await truncate(exact, MAX_SEND_FILE_BYTES);
    await t.call({ chat_id: "c", path: exact });
    expect(t.sendMediaMessage).toHaveBeenCalledTimes(1);
    const over = await file(t.workspace, "over.bin", "");
    await truncate(over, MAX_SEND_FILE_BYTES + 1);
    await expect(t.call({ chat_id: "c", path: over })).rejects.toThrow("100 MiB");
    expect(t.sendMediaMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when no ClawChat turn is running (background call after the turn ended)", async () => {
    const t = await setup([]);
    await expect(t.call({ chat_id: "c", path: await file(t.workspace, "a.txt") })).rejects.toThrow(
      "No ClawChat conversation is active",
    );
    expect(t.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("limits a non-owner turn to its own chat and lets owner-only turns reach other chats", async () => {
    const stranger = await setup([strangerTurn("chat-s")]);
    const path = await file(stranger.workspace, "a.txt");
    await expect(stranger.call({ chat_id: "chat-other", path })).rejects.toThrow("Cross-conversation access");
    await stranger.call({ chat_id: "chat-s", path });
    expect(stranger.sendMediaMessage).toHaveBeenCalledTimes(1);

    const owner = await setup([ownerTurn("chat-o")]);
    await owner.call({ chat_id: "chat-other", path: await file(owner.workspace, "a.txt") });
    expect(owner.sendMediaMessage).toHaveBeenCalledTimes(1);
  });

  it("denies a concurrent non-owner turn leaking into another chat, and ambiguous non-owner chats", async () => {
    const t = await setup([strangerTurn("chat-b"), strangerTurn("chat-d")]);
    const path = await file(t.workspace, "a.txt");
    for (const chat_id of ["chat-b", "chat-d", "chat-other"]) {
      await expect(t.call({ chat_id, path })).rejects.toThrow(/ambiguous|Cross-conversation/u);
    }
    await expect(t.call({ chat_id: "chat-b", path })).rejects.toThrow("retry after the other conversation finishes");

    const mixed = await setup([ownerTurn("chat-o"), strangerTurn("chat-b")]);
    const mixedPath = await file(mixed.workspace, "a.txt");
    await expect(mixed.call({ chat_id: "chat-o", path: mixedPath })).rejects.toThrow("Cross-conversation");
    await mixed.call({ chat_id: "chat-b", path: mixedPath });
    expect(mixed.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(t.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("treats a group batch with a non-owner speaker as restricted", () => {
    const batch: ActiveClawChatTurn = { chatId: "g", chatType: "group", speakerIds: ["owner-1", "friend"] };
    expect(() => authorizeSendFileTarget({ chatId: "other", ownerUserId: "owner-1", activeTurns: [batch] })).toThrow(
      "Cross-conversation",
    );
    expect(authorizeSendFileTarget({ chatId: "g", ownerUserId: "owner-1", activeTurns: [batch] })).toEqual({
      restricted: true,
      chatType: "group",
    });
  });

  it("fails closed when no Workspace is configured", async () => {
    const t = await setup();
    await expect(
      executeConnectTool(
        "clawchat_send_file",
        { chat_id: "chat-o", path: join(t.workspace, "a") },
        {
          baseUrl: "https://example.test",
          deviceId: "d",
          activation,
          wsClient: {} as ConnectWsClient,
          activeTurns: () => [ownerTurn()],
        },
      ),
    ).rejects.toThrow("no Workspace");
  });
});
