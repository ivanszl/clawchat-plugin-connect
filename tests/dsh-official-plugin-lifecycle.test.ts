import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import { type Envelope, EVENT } from "../src/clawchat/protocol";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectPluginHost } from "../src/plugin/host";
import deepSeekHarnessDescriptor from "../src/plugin/official/deepseek-harness-descriptor";
import {
  DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
  DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
} from "../src/plugin/official/deepseek-harness-manifest";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { startBindingRuntime } from "../src/service/binding-runtime";
import { startConnectService } from "../src/service/connect-service";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

const OWNER = "usr_owner";
const AGENT = "usr_agent";
const target = `${process.platform}-${process.arch}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Production loads DeepSeek Harness only as the built official Plugin Bundle through the Plugin host, never
 * through the Adapter factory directly. This drives one message through that exact path: bundled Plugin installed
 * from an official-plugins directory, `service exec` (startConnectService) activating the installed Plugin, a real
 * WebSocket ClawChat server, and a stand-in `dsh` executable speaking the Bridge protocol. The Core's stdout must
 * carry the lifecycle lines.
 */
describe("DSH lifecycle log through the official Plugin host", () => {
  it("writes the ordered lifecycle lines for one message turn on the Core's stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawchat-dsh-official-"));
    cleanups.push(async () => await rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, "profiles", "default"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    const canonicalHome = await realpath(home);

    // The built official Bundle, laid out like the release's official-plugins directory.
    const officialDirectory = join(root, "official-plugins");
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await buildOfficialPlugin(deepSeekHarnessDescriptor, { target, outputDirectory: officialDirectory });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    const fakeDsh = join(root, "dsh");
    await writeFile(
      fakeDsh,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("tests/fixtures/fake-dsh.mjs"))} "$@"\n`,
    );
    await chmod(fakeDsh, 0o700);

    // A fake ClawChat server: Protocol v2 handshake, one inbound message, acknowledges every reply.
    const received: Envelope[] = [];
    const sockets = new Set<ServerWebSocket<unknown>>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, serverInstance) {
        if (serverInstance.upgrade(request)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          sockets.add(socket);
          socket.send(
            JSON.stringify({
              version: "2",
              event: EVENT.CONNECT_CHALLENGE,
              trace_id: "challenge",
              emitted_at: 1,
              payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
            }),
          );
        },
        close(socket) {
          sockets.delete(socket);
        },
        message(socket, data) {
          const envelope = JSON.parse(String(data)) as Envelope;
          received.push(envelope);
          if (envelope.event === EVENT.CONNECT) {
            socket.send(
              JSON.stringify({
                version: "2",
                event: EVENT.HELLO_OK,
                trace_id: envelope.trace_id,
                emitted_at: 2,
                payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
              }),
            );
          }
          if (envelope.event === EVENT.MESSAGE_REPLY) {
            socket.send(
              JSON.stringify({
                version: "2",
                event: EVENT.MESSAGE_ACK,
                trace_id: envelope.trace_id,
                emitted_at: 1,
                chat_id: envelope.chat_id,
                payload: { message_id: `reply-${received.length}`, accepted_at: 1 },
              }),
            );
          }
        },
      },
    });
    cleanups.push(async () => {
      await server.stop(true);
    });

    const configPath = join(root, "config.json");
    const config = defaultConfig();
    config.baseUrl = `http://127.0.0.1:${server.port}`;
    config.websocketUrl = `ws://127.0.0.1:${server.port}/ws`;
    config.mediaUploadUrl = `http://127.0.0.1:${server.port}/media`;
    config.stateDbPath = join(root, "state.sqlite");
    config.defaultAgent = "dsh";
    config.agents = {
      dsh: {
        runtime: {
          pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
          capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
        },
        runtimeConfig: {
          profile: "default",
          homePath: canonicalHome,
          executablePathOverride: fakeDsh,
        },
        displayName: "Agent",
      },
    };

    // Install the official Bundle and seed the activation, as `plugin setup` and activation do before the service runs.
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.upsertActivation({
      localAgentId: "dsh",
      accessToken: "token",
      refreshToken: null,
      serverAgentId: "agt_server",
      userId: AGENT,
      ownerUserId: OWNER,
      conversationId: "chat-owner",
    });
    const installer = new ConnectPluginHost(
      configPath,
      new RuntimeAdapterRegistry([]),
      () => undefined,
      { config, stateStore: store, workspaces: new WorkspaceCatalog(store) },
      { officialPluginsDirectory: officialDirectory, target },
    );
    await installer.discoverOfficial();
    await installer.installOfficial([DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID]);
    await installer.close();
    await store.close();

    // `clawchat-connect service exec`: the Core's stdout and stderr are what the runtime forwards to its log.
    const stdout: string[] = [];
    const stderr: string[] = [];
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    let shutdown: () => void = () => undefined;
    const stopped = new Promise<void>((resolveStop) => {
      shutdown = resolveStop;
    });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const restoreStdout = () => {
      process.stdout.write = realStdoutWrite;
    };
    const running = startConnectService(
      {
        configPath,
        config,
        waitUntilShutdown: async () => await stopped,
        writeOutput: (message) => stdout.push(message),
        writeError: (message) => stderr.push(message),
      },
      {
        verifyInstalledSkills: async () => undefined,
        // The managed Agent skills are installed on a real host; the Binding runtime checks them again itself.
        startBindingRuntime: async (options) =>
          await startBindingRuntime({ ...options, verifyInstalledSkills: async () => undefined }),
      },
    ).finally(restoreStdout);
    cleanups.push(async () => {
      shutdown();
      await running.catch(() => undefined);
      restoreStdout();
    });

    const waitFor = async (predicate: () => boolean, what: string) => {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`${what}\nSTDOUT:\n${stdout.join("")}\nSTDERR:\n${stderr.join("")}`);
        }
        await Bun.sleep(10);
      }
    };
    await waitFor(() => received.some((envelope) => envelope.event === EVENT.CONNECT), "binding never connected");
    await Bun.sleep(50);
    for (const socket of sockets) {
      socket.send(
        JSON.stringify({
          version: "2",
          event: EVENT.MESSAGE_SEND,
          trace_id: "trace-msg-1",
          emitted_at: 3,
          dseq: 1,
          chat_id: "chat-owner",
          chat_type: "direct",
          sender: { id: OWNER, type: "direct", nick_name: "Owner" },
          payload: {
            message_id: "msg-1",
            message_mode: "normal",
            message: {
              body: { fragments: [{ kind: "text", text: "hello there" }] },
              context: { mentions: [], reply: null },
              streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
            },
          },
        }),
      );
    }
    // The message really ran through the Plugin's Adapter and the reply reached the server...
    await waitFor(
      () => received.some((envelope) => envelope.event === EVENT.MESSAGE_REPLY),
      "no reply reached ClawChat",
    );
    const lifecycleRecords = () =>
      stdout
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("clawchat-lifecycle "))
        .map((line) => JSON.parse(line.slice("clawchat-lifecycle ".length)) as Record<string, unknown>);
    await waitFor(
      () => lifecycleRecords().some((record) => record.step === "turn_finished" || record.step === "turn_failed"),
      "no terminal lifecycle line on the Core's stdout",
    );

    expect(lifecycleRecords().map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { v: 1, runtime: "dsh", step: "received", msg: "msg-1", chat: "chat-owner" },
      { v: 1, runtime: "dsh", step: "turn_started", msg: "msg-1", turn: "msg-1", chat: "chat-owner" },
      { v: 1, runtime: "dsh", step: "reply_sent", msg: "msg-1", turn: "msg-1", chat: "chat-owner" },
      { v: 1, runtime: "dsh", step: "turn_finished", msg: "msg-1", turn: "msg-1", chat: "chat-owner" },
    ]);
    expect(received.some((envelope) => envelope.event === EVENT.MESSAGE_REPLY)).toBe(true);
  }, 60_000);
});
