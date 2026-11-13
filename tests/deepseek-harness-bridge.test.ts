import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  DSH_BRIDGE_MAX_FRAME_BYTES,
  type DshBridgeEvent,
  type DshBridgeFrame,
  parseDshBridgeFrame,
} from "../src/runtime/deepseek-harness-protocol";

const BRIDGE_URL = pathToFileURL(join(import.meta.dir, "../src/plugin/official/deepseek-harness-bridge.mjs")).href;

// Runs the real Bridge module against a minimal fake DSH context. Commands arrive on stdin as JSON lines.
const RUNNER = `
import { apply } from ${JSON.stringify(BRIDGE_URL)};
import { createInterface } from "node:readline";
const handlers = new Map();
const session = { id: "s1", header: { id: "s1", createdAt: 1 }, seq: 0, events: [], requestHeader() { return undefined; } };
const agent = { id: "s1", session, status: "idle" };
const ctx = {
  on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); },
  inject(_dependencies, callback) { callback(ctx); return { async dispose() {} }; },
  root: { get: (name) => (name === "loader" ? { await: async () => {} } : undefined) },
  get: () => undefined,
  agents: { async create({ setup }) { await setup({ agent }, agent); return { agent, async dispose() {} }; } },
  sessions: { async flush() {} },
  llm: {},
};
await apply(ctx, { build: "test-build", home: "/home/test" });
const toolResult = (blocks) => ({
  seq: 1, time: 1, type: "tool/result",
  data: { turn: 1, message: { source: { callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", isError: false, content: blocks }] } },
});
const build = (command) => {
  if (command.kind === "text") return toolResult([{ type: "text", text: "a".repeat(command.bytes) }]);
  if (command.kind === "image") return toolResult([{ type: "text", text: "see image" }, { type: "image", mediaType: "image/png", data: Buffer.alloc(command.bytes, 7).toString("base64") }]);
  if (command.kind === "many") return { seq: 2, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "completed" }, blob: Array.from({ length: command.count }, (_, i) => i + ":" + "y".repeat(500)) } };
  throw new Error("unknown event kind");
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  try {
    if (command.cmd === "emit") handlers.get("session/event")({ id: "s1" }, build(command));
    if (command.cmd === "history-event") session.events.push(build(command));
    if (command.cmd === "history-user") session.events.push({ seq: command.seq, time: 1, type: "user/message", data: { id: "m1", turn: 1, source: { kind: "user", connectInputId: command.inputId } } });
    if (command.cmd === "history-turn-start") session.events.push({ seq: command.seq, time: 1, type: "turn/start", data: { turn: 2 } });
    if (command.cmd === "history-events") for (let i = 0; i < command.count; i++) session.events.push({ seq: i, time: 1, type: "x", data: { text: "z".repeat(command.size) } });
    console.log(JSON.stringify({ done: command.cmd }));
  } catch (error) {
    console.log(JSON.stringify({ threw: String(error?.message ?? error) }));
  }
});
`;

interface Harness {
  child: ChildProcess;
  frames: DshBridgeFrame[];
  rawLines: string[];
  control: string[];
  stderr: { text: string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  command(value: unknown): Promise<void>;
  request(method: string, params?: unknown): Promise<Extract<DshBridgeFrame, { type: "response" }>>;
  waitFor<T extends DshBridgeFrame>(predicate: (frame: DshBridgeFrame) => frame is T): Promise<T>;
  waitControl(count: number): Promise<void>;
  directory: string;
}

const cleanups: Array<() => Promise<void>> = [];
// Bun can close a finished child's inherited-pipe sockets late; keeping the handles reachable avoids that racing a later test.
const retained: unknown[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startBridge(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "connect-dsh-bridge-"));
  const stub = (name: string, source: string) =>
    mkdir(join(directory, "node_modules/@deepseek-ai", name), { recursive: true }).then(() =>
      Promise.all([
        Bun.write(
          join(directory, "node_modules/@deepseek-ai", name, "package.json"),
          JSON.stringify({ name, type: "module", main: "index.mjs" }),
        ),
        Bun.write(join(directory, "node_modules/@deepseek-ai", name, "index.mjs"), source),
      ]),
    );
  await stub("dsh-llm", "export const contentHasImage = () => false; export const createUserMessage = () => ({});");
  await stub("dsh-agent", "export const installModelSelection = () => () => {};");
  const runner = join(directory, "runner.mjs");
  await Bun.write(runner, RUNNER);
  const child = spawn(process.execPath, [runner], {
    cwd: directory,
    env: { ...process.env, CONNECT_DSH_BRIDGE_FD_OUT: "3", CONNECT_DSH_BRIDGE_FD_IN: "4" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  // Bun connects inherited-pipe stdio lazily; touch both ends before the child can write.
  const fromBridge = child.stdio[3] as Readable;
  const toBridge = child.stdio[4] as Writable;
  const stderr = { text: "" };
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr.text += chunk;
  });
  const frames: DshBridgeFrame[] = [];
  const rawLines: string[] = [];
  const control: string[] = [];
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  createInterface({ input: fromBridge, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
    rawLines.push(line);
    frames.push(parseDshBridgeFrame(line));
    notify();
  });
  createInterface({ input: child.stdout as Readable }).on("line", (line) => {
    control.push(line);
    notify();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 20_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`timed out; stderr: ${stderr.text}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  };
  let sequence = 0;
  const harness: Harness = {
    child,
    frames,
    rawLines,
    control,
    stderr,
    exited,
    directory,
    async command(value) {
      const before = control.length;
      (child.stdin as Writable).write(`${JSON.stringify(value)}\n`);
      await until(() => control.length > before);
      expect(control.at(-1)).toContain("done");
    },
    async waitControl(count) {
      await until(() => control.length >= count);
    },
    async request(method, params = {}) {
      const id = `t-${++sequence}`;
      toBridge.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);
      let found: Extract<DshBridgeFrame, { type: "response" }> | undefined;
      await until(() => {
        found = frames.find(
          (frame): frame is Extract<DshBridgeFrame, { type: "response" }> =>
            frame.type === "response" && frame.id === id,
        );
        return Boolean(found);
      });
      return found as Extract<DshBridgeFrame, { type: "response" }>;
    },
    async waitFor(predicate) {
      let found: DshBridgeFrame | undefined;
      await until(() => {
        found = frames.find(predicate);
        return Boolean(found);
      });
      return found as never;
    },
  };
  retained.push(harness);
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  await harness.waitFor((frame): frame is Extract<DshBridgeFrame, { type: "hello" }> => frame.type === "hello");
  await harness.request("create", { sessionId: "s1", cwd: "/work" });
  return harness;
}

const isEvent = (frame: DshBridgeFrame): frame is DshBridgeEvent => frame.type === "event";
const alive = (harness: Harness) => harness.child.exitCode === null && harness.child.signalCode === null;
const toolText = (frame: DshBridgeEvent) => (frame.event.data as any).message.content[0].content[0].text as string;

describe("DeepSeek Harness Bridge frame limit", () => {
  it("announces protocol 2 and the shared 16 MiB limit", async () => {
    const bridge = await startBridge();
    const hello = bridge.frames.find((frame) => frame.type === "hello");
    expect(hello).toMatchObject({ protocol: { major: 2, maxFrameBytes: DSH_BRIDGE_MAX_FRAME_BYTES } });
  }, 60_000);

  it("forwards a 2 MiB tool output untouched", async () => {
    const bridge = await startBridge();
    await bridge.command({ cmd: "emit", kind: "text", bytes: 2 * 1024 * 1024 });
    const frame = await bridge.waitFor(isEvent);
    expect(toolText(frame)).toHaveLength(2 * 1024 * 1024);
    expect(frame.event.truncated).toBeUndefined();
  }, 60_000);

  it("degrades a tool output above the limit, survives, and keeps serving requests", async () => {
    const bridge = await startBridge();
    await bridge.command({ cmd: "emit", kind: "text", bytes: DSH_BRIDGE_MAX_FRAME_BYTES + 4 * 1024 * 1024 });
    const frame = await bridge.waitFor(isEvent);
    expect(Buffer.byteLength(bridge.rawLines.at(-1) ?? "")).toBeLessThanOrEqual(DSH_BRIDGE_MAX_FRAME_BYTES);
    expect(toolText(frame)).toEndWith(`[output truncated: ${DSH_BRIDGE_MAX_FRAME_BYTES + 4 * 1024 * 1024} bytes]`);
    expect(frame.event.truncated).toMatchObject({ truncated: true, fields: [{ kind: "text" }] });
    expect(bridge.stderr.text).toContain("degraded");
    expect(alive(bridge)).toBe(true);
    await expect(bridge.request("history", { sessionId: "missing" })).resolves.toMatchObject({ ok: false });
    expect(alive(bridge)).toBe(true);
  }, 60_000);

  it("degrades an event with a large inline image", async () => {
    const bridge = await startBridge();
    await bridge.command({ cmd: "emit", kind: "image", bytes: 14 * 1024 * 1024 });
    const frame = await bridge.waitFor(isEvent);
    const blocks = (frame.event.data as any).message.content[0].content;
    expect(blocks[0].text).toBe("see image");
    expect(blocks[1].data).toMatch(/^\[binary omitted: \d+ bytes\]$/u);
    expect(frame.event.truncated?.fields[0]).toMatchObject({ kind: "binary" });
    expect(alive(bridge)).toBe(true);
  }, 60_000);

  it("sends a minimal placeholder when an event cannot be shrunk and still ends the Turn", async () => {
    const bridge = await startBridge();
    await bridge.command({ cmd: "emit", kind: "many", count: 40_000 });
    const frame = await bridge.waitFor(isEvent);
    expect(frame.event).toMatchObject({
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
      truncated: { truncated: true, placeholder: true },
    });
    expect(alive(bridge)).toBe(true);
  }, 60_000);

  it("degrades a single oversized history event inside its page instead of failing the request", async () => {
    const bridge = await startBridge();
    await bridge.command({ cmd: "history-event", kind: "text", bytes: DSH_BRIDGE_MAX_FRAME_BYTES + 1024 });
    const page = await bridge.request("history", { sessionId: "s1" });
    expect(page.ok).toBe(true);
    expect(Buffer.byteLength(bridge.rawLines.at(-1) ?? "")).toBeLessThanOrEqual(DSH_BRIDGE_MAX_FRAME_BYTES);
    expect(alive(bridge)).toBe(true);
  }, 60_000);

  it("serves a Session larger than the frame limit as bounded windows and still reconciles", async () => {
    const bridge = await startBridge();
    // 5000 x ~4 KB = ~20 MB of events: more than one 16 MiB frame, which used to fail every Turn.
    await bridge.command({ cmd: "history-events", count: 5_000, size: 4_000 });
    await bridge.command({ cmd: "history-user", seq: 10_000, inputId: "input-42" });
    await bridge.command({ cmd: "history-turn-start", seq: 10_001 });
    const unbounded = await bridge.request("history", { sessionId: "s1" });
    const window = (
      unbounded as { result: { events: Array<{ seq: number }>; complete: boolean; nextBeforeSeq: number | null } }
    ).result;
    expect(unbounded.ok).toBe(true);
    expect(Buffer.byteLength(bridge.rawLines.at(-1) ?? "")).toBeLessThan(8 * 1024 * 1024);
    expect(window.events.at(-1)?.seq).toBe(10_001);
    expect(window.events.length).toBeLessThan(5_002);
    expect(window).toMatchObject({ complete: false });
    expect(window.nextBeforeSeq).toBe(window.events[0]?.seq);
    for (const raw of bridge.rawLines) expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(DSH_BRIDGE_MAX_FRAME_BYTES);

    const older = await bridge.request("history", {
      sessionId: "s1",
      beforeSeq: window.nextBeforeSeq,
      maxBytes: 100_000,
    });
    expect((older as { result: { events: unknown[] } }).result.events.length).toBeGreaterThan(0);
    const headerOnly = await bridge.request("history", { sessionId: "s1", headerOnly: true });
    expect((headerOnly as { result: { events: unknown[]; header: unknown } }).result).toMatchObject({
      events: [],
      header: { id: "s1" },
    });
    const tail = await bridge.request("history", { sessionId: "s1", lastTurns: 1 });
    expect((tail as { result: { events: unknown[] } }).result.events).toHaveLength(1);
    const users = await bridge.request("history", { sessionId: "s1", types: ["user/message"] });
    expect((users as { result: { events: unknown[]; complete: boolean } }).result).toMatchObject({ complete: true });
    await expect(bridge.request("reconcile", { sessionId: "s1", inputId: "input-42" })).resolves.toMatchObject({
      ok: true,
      result: { outcome: "accepted", inputId: "input-42" },
    });
    expect(alive(bridge)).toBe(true);
  }, 60_000);

  it("logs and terminates on an oversized incoming line", async () => {
    const bridge = await startBridge();
    (bridge.child.stdio[4] as Writable).write(`${"x".repeat(DSH_BRIDGE_MAX_FRAME_BYTES + 1)}\n`);
    const result = await bridge.exited;
    expect(result.signal).toBe("SIGTERM");
    expect(bridge.stderr.text).toContain("incoming frame");
    expect(bridge.stderr.text).toContain("exceeds");
  }, 60_000);

  it("still terminates when the pipe itself breaks", async () => {
    const bridge = await startBridge();
    (bridge.child.stdio[3] as Readable).destroy();
    await Bun.sleep(50);
    await bridge.command({ cmd: "emit", kind: "text", bytes: 1024 }).catch(() => undefined);
    const result = await Promise.race([bridge.exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
    expect(result).not.toBe("timeout");
    expect(bridge.stderr.text).toContain("terminating");
  }, 60_000);
});
