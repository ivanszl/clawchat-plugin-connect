import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import type { RuntimeOutputEvent } from "../src/output-visibility";
import { ProjectCatalog } from "../src/projects";
import type { NormalizedInboundMessage } from "../src/protocol";
import { ConnectRuntime } from "../src/runtime/connect-runtime";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
} from "../src/runtime/types";
import { createStateStore } from "../src/state";
import type { ConnectWsClient } from "../src/ws-client";

function message(text = "hello"): NormalizedInboundMessage {
  return {
    event: "message.send",
    chatId: "chat-1",
    chatType: "direct",
    messageId: "message-1",
    traceId: "trace-1",
    sender: { id: "user-1", type: "direct", nick_name: "User" },
    emittedAt: Date.now(),
    text,
    fragments: [{ kind: "text", text }],
    mentions: [],
    replyToMessageId: null,
    raw: {} as never,
  };
}

function session(
  prompt: (context: ConnectRuntimeStartContext) => AsyncIterable<RuntimeOutputEvent>,
  context: ConnectRuntimeStartContext,
): ConnectRuntimeSession {
  return {
    prompt: () => prompt(context),
    close: mock(async () => undefined),
    cancel: mock(async () => true),
  };
}

async function runtimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-runtime-"));
  const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
  config.stateDbPath = join(directory, "state.sqlite");
  const store = createStateStore({ dbPath: config.stateDbPath });
  await store.upsertRuntimeSession({
    chatId: "chat-1",
    sessionId: "session-1",
    agentId: "codex",
    projectId: null,
    isCurrent: true,
  });
  const uploadMedia = mock(async (_file: Blob, _options?: { filename?: string }) => ({
    kind: "image" as const,
    url: "https://cdn.example/uploaded-image",
    name: "00-TheFool.jpg",
    mime: "image/jpeg",
    size: 11,
  }));
  const sendMessageEnvelope = mock(async () => ({ payload: {} }));
  const wsClient = { uploadMedia, sendMessageEnvelope } as unknown as ConnectWsClient;
  return { config, store, wsClient, uploadMedia, sendMessageEnvelope, configPath: join(directory, "config.json") };
}

describe("ConnectRuntime Agent Binding sessions", () => {
  it("starts the first message in a Non-Project Session with an isolated workspace", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.deleteRuntimeSession("chat-1", "codex", "session-1");
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield { kind: "final", text: "done" } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await runtime.handleInboundMessage(message());

    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({ projectId: null });
    const promptInput = prompts[0];
    if (!promptInput) throw new Error("expected runtime prompt");
    expect(promptInput.workspace).toMatchObject({ projectId: null, skipGitRepoCheck: true });
    expect((await stat(promptInput.workspace.workingDirectory)).isDirectory()).toBe(true);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("preserves inbound ClawChat media for the Runtime Adapter", async () => {
    const fixture = await runtimeFixture();
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield { kind: "final", text: "done" } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });
    const inbound = message("describe the attachments");
    inbound.fragments = [
      { kind: "text", text: "describe the attachments" },
      {
        kind: "image",
        url: "https://media.example/photo.png?signature=opaque",
        name: "photo.png",
        mime: "image/png",
        size: 123,
      },
      {
        kind: "file",
        url: "https://media.example/report.pdf?signature=opaque",
        name: "report.pdf",
        mime: "application/pdf",
        size: 456,
      },
    ];

    await runtime.handleInboundMessage(inbound);

    expect(prompts[0]).toMatchObject({
      media: [
        {
          kind: "image",
          url: "https://media.example/photo.png?signature=opaque",
          name: "photo.png",
          mime: "image/png",
          size: 123,
        },
        {
          kind: "file",
          url: "https://media.example/report.pdf?signature=opaque",
          name: "report.pdf",
          mime: "application/pdf",
          size: 456,
        },
      ],
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("uploads a safe local Markdown image before replying with a media Fragment", async () => {
    const fixture = await runtimeFixture();
    const imagePath = join(dirname(fixture.config.stateDbPath), "media-cache", "cached-image", "00-TheFool.jpg");
    await mkdir(dirname(imagePath), { recursive: true });
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    await writeFile(imagePath, imageBytes);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* () {
          yield { kind: "final", text: `![00-TheFool.jpg](${imagePath})` } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await runtime.handleInboundMessage(message("send the image back"));

    expect(fixture.uploadMedia).toHaveBeenCalledTimes(1);
    const [uploadedFile, uploadOptions] = fixture.uploadMedia.mock.calls[0] ?? [];
    expect(uploadOptions).toEqual({ filename: "00-TheFool.jpg" });
    expect(Buffer.from(await uploadedFile?.arrayBuffer())).toEqual(imageBytes);
    expect(fixture.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.reply",
      "chat-1",
      expect.objectContaining({
        message: {
          body: {
            fragments: [
              {
                kind: "image",
                url: "https://cdn.example/uploaded-image",
                name: "00-TheFool.jpg",
                mime: "image/jpeg",
                size: 11,
              },
            ],
          },
          context: expect.any(Object),
        },
      }),
      { toType: "direct" },
    );
    await runtime.dispose();
    await fixture.store.close();
  });

  it("does not turn a non-image workspace file into an outbound media Fragment", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test session was not created");
    const workspace = await new ProjectCatalog(fixture.store).resolveWorkspace(current);
    const secretPath = join(workspace.workingDirectory, ".env");
    await writeFile(secretPath, "SECRET_TOKEN=do-not-upload\n");
    const markdown = `![result](${secretPath})`;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* () {
          yield { kind: "final", text: markdown } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await runtime.handleInboundMessage(message("send the result"));

    expect(fixture.uploadMedia).not.toHaveBeenCalled();
    expect(fixture.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.reply",
      "chat-1",
      expect.objectContaining({
        message: expect.objectContaining({ body: { fragments: [{ kind: "text", text: markdown }] } }),
      }),
      { toType: "direct" },
    );
    await runtime.dispose();
    await fixture.store.close();
  });

  it("does not upload a local Markdown image outside the media cache or Runtime Workspace", async () => {
    const fixture = await runtimeFixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "clawchat-outside-media-"));
    const outsideImage = join(outsideDirectory, "private.png");
    await writeFile(outsideImage, "private-bytes");
    const markdown = `![private.png](${outsideImage})`;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* () {
          yield { kind: "final", text: markdown } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await runtime.handleInboundMessage(message("send a private file"));

    expect(fixture.uploadMedia).not.toHaveBeenCalled();
    expect(fixture.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.reply",
      "chat-1",
      expect.objectContaining({
        message: expect.objectContaining({
          body: { fragments: [{ kind: "text", text: markdown }] },
        }),
      }),
      { toType: "direct" },
    );
    await runtime.dispose();
    await fixture.store.close();
  });

  it("discovers within a pending Project and materializes its Session on the first message", async () => {
    const fixture = await runtimeFixture();
    const projects = new ProjectCatalog(fixture.store);
    const projectRoot = await mkdtemp(join(tmpdir(), "clawchat-connect-selected-project-"));
    const canonicalProjectRoot = await realpath(projectRoot);
    const project = await projects.add("selected", projectRoot);
    await fixture.store.setSessionIntent({
      chatId: "chat-1",
      agentId: "codex",
      projectId: project.projectId,
      name: "Planned work",
      mode: "read-only",
    });
    const discoveredWorkspaces: string[] = [];
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      discoverThreads: mock(async (_agent, workspace) => {
        discoveredWorkspaces.push(workspace.workingDirectory);
        return [{ runtimeThreadId: "thread-existing", name: "Existing thread", updatedAt: 1 }];
      }),
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield { kind: "final", text: "done" } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      projects,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toBeNull();
    await expect(runtime.discoverRuntimeThreads("chat-1")).resolves.toEqual([
      expect.objectContaining({ runtimeThreadId: "thread-existing", name: "Existing thread" }),
    ]);
    expect(discoveredWorkspaces).toEqual([canonicalProjectRoot]);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toBeNull();

    await runtime.handleInboundMessage(message("start planned work"));

    await expect(fixture.store.getSessionIntent("chat-1", "codex")).resolves.toBeNull();
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      projectId: project.projectId,
      name: "Planned work",
      mode: "read-only",
      hasMessages: true,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      workspace: { projectId: project.projectId, workingDirectory: canonicalProjectRoot },
      mode: "read-only",
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("serializes lifecycle commands behind an active turn for the same chat", async () => {
    const fixture = await runtimeFixture();
    let releaseTurn: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const order: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* () {
          order.push("turn-started");
          markStarted?.();
          await release;
          order.push("turn-finished");
          yield { kind: "final", text: "done" } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    const turn = runtime.handleInboundMessage(message());
    await started;
    await expect(fixture.store.getRuntimeStatus("codex")).resolves.toMatchObject({
      globalRunning: 1,
      globalQueued: 0,
    });
    const command = runtime.handleInboundMessage(message("/project clear"), async () => {
      order.push("command");
      return true;
    });
    await Bun.sleep(5);
    expect(order).toEqual(["turn-started"]);
    releaseTurn?.();
    await Promise.all([turn, command]);
    expect(order).toEqual(["turn-started", "turn-finished", "command"]);
    await expect(fixture.store.getRuntimeStatus("codex")).resolves.toMatchObject({
      globalRunning: 0,
      globalQueued: 0,
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("serializes ClawChat and Client turns on the same logical Session", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test session was not created");
    let releaseClawChat: (() => void) | undefined;
    let markClawChatStarted: (() => void) | undefined;
    let markClientFinished: (() => void) | undefined;
    const clawChatStarted = new Promise<void>((resolve) => {
      markClawChatStarted = resolve;
    });
    const clientFinished = new Promise<void>((resolve) => {
      markClientFinished = resolve;
    });
    const clawChatGate = new Promise<void>((resolve) => {
      releaseClawChat = resolve;
    });
    const order: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          if (input.metadata?.origin === "client") {
            order.push("client-started", "client-finished");
            markClientFinished?.();
          } else {
            order.push("clawchat-started");
            markClawChatStarted?.();
            await clawChatGate;
            order.push("clawchat-finished");
          }
          yield { kind: "final", text: "done" } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    const clawChatTurn = runtime.handleInboundMessage(message("from clawchat"));
    await clawChatStarted;
    await runtime.enqueueClientTurn(current.sessionRef, "from web");
    await Bun.sleep(5);
    expect(order).toEqual(["clawchat-started"]);
    releaseClawChat?.();
    await Promise.all([clawChatTurn, clientFinished]);
    expect(order).toEqual(["clawchat-started", "clawchat-finished", "client-started", "client-finished"]);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("persists a Codex thread id and resumes it after runtime restart", async () => {
    const fixture = await runtimeFixture();
    const starts: ConnectRuntimeStartContext[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async (_agent, context) => {
        starts.push(context);
        return session(async function* (startContext) {
          await startContext.onRuntimeSessionId("thread-1");
          yield { kind: "final", text: "done" };
        }, context);
      }),
    };

    const first = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });
    await first.handleInboundMessage(message());
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await first.dispose();

    const second = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });
    await second.handleInboundMessage(message("again"));

    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ runtimeSessionId: null, configPath: fixture.configPath });
    expect(starts[1]).toMatchObject({ runtimeSessionId: "thread-1", configPath: fixture.configPath });
    await second.dispose();
    await fixture.store.close();
  });

  it("backfills names for managed Runtime Threads and returns only unclaimed discoveries", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.setRuntimeSessionId("chat-1", "codex", "session-1", "thread-managed");
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      discoverThreads: mock(async () => [
        { runtimeThreadId: "thread-managed", name: "Managed history", updatedAt: 2 },
        { runtimeThreadId: "thread-external", name: "External history", updatedAt: 1 },
      ]),
      start: mock(async () => session(async function* () {}, {} as ConnectRuntimeStartContext)),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    const discovered = await runtime.discoverRuntimeThreads("chat-1");
    expect(discovered).toEqual([
      {
        runtimeThreadId: "thread-external",
        name: "External history",
        updatedAt: 1,
        sessionRef: expect.stringMatching(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u),
      },
    ]);
    await expect(runtime.discoverRuntimeThreads("chat-1")).resolves.toEqual(discovered);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      name: "Managed history",
    });
    await fixture.store.close();
  });

  it("preserves a thread when closing and clears it when invalidating", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.setRuntimeSessionId("chat-1", "codex", "session-1", "thread-1");
    const createdSessions: ConnectRuntimeSession[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async (_agent, context) => {
        const created = session(async function* () {
          yield { kind: "final", text: "done" };
        }, context);
        createdSessions.push(created);
        return created;
      }),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await runtime.handleInboundMessage(message());
    await expect(runtime.closeSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await runtime.handleInboundMessage(message("resume"));
    await expect(runtime.invalidateSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: null,
    });
    expect(createdSessions.every((created) => (created.close as ReturnType<typeof mock>).mock.calls.length === 1)).toBe(
      true,
    );
    await fixture.store.close();
  });
});
