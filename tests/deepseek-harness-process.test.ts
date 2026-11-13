import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireDshExecutable,
  requireDshPackageCommand,
  startDshBridge,
} from "../src/runtime/deepseek-harness-process";
import { DSH_BRIDGE_MAX_FRAME_BYTES, parseDshBridgeFrame } from "../src/runtime/deepseek-harness-protocol";

const FRAME_MODULE = new URL("../src/plugin/official/deepseek-harness-frame.mjs", import.meta.url).href;

const FAKE_DSH = `#!/usr/bin/env bun
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] !== "--package-marker") process.exit(5);
const patchIndex = process.argv.indexOf("--patch");
const patch = readFileSync(process.argv[patchIndex + 1], "utf8");
const config = Object.fromEntries(
  [...patch.matchAll(/^\\s+(build|home|profile): (.+)$/gm)].map((match) => [match[1], JSON.parse(match[2])]),
);
const output = createWriteStream(null, { fd: 3 });
const input = createReadStream(null, { fd: 4 });
output.write(JSON.stringify({
  type: "hello",
  protocol: { name: "clawchat-connect-dsh-bridge", major: 2, build: config.build },
  home: config.home,
  profile: config.profile,
  capabilities: {
    promptQueue: true, promptSteer: true, cancel: true, durableReceipt: true, history: true,
    approvals: false, questions: false, models: true, presets: false, permissionPresets: false,
    skills: true, commands: true, imageInput: false, localProducedFilePresentation: false,
    portableArtifactOutput: false, archive: true, restore: false, delete: false,
    crossProcessSessionOwnership: false,
  },
}) + "\\n");
// SDK profiles drain on stdin EOF even though Bridge RPC uses inherited pipes.
process.stdin.resume();
process.stdin.on("end", () => process.exit(17));
const lines = createInterface({ input, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  output.write(JSON.stringify({ type: "response", id: request.id, ok: true, result: request.params }) + "\\n");
});
`;

const FAKE_DSH_BIG = FAKE_DSH.replace(
  '  output.write(JSON.stringify({ type: "response", id: request.id, ok: true, result: request.params }) + "\\n");',
  `  if (request.method === "emit-big") {
    const text = "t".repeat(20 * 1024 * 1024);
    const frame = { type: "event", sessionId: "s1", event: { seq: 1, time: 1, type: "tool/result", data: { turn: 1, text } } };
    output.write(encodeBridgeFrame(frame).encoded);
  }
  if (request.method === "emit-oversized") output.write("x".repeat(${DSH_BRIDGE_MAX_FRAME_BYTES} + 1) + "\\n");
  output.write(JSON.stringify({ type: "response", id: request.id, ok: true, result: request.params }) + "\\n");`,
).replace(
  'import { createInterface } from "node:readline";',
  `import { createInterface } from "node:readline";\nimport { encodeBridgeFrame } from ${JSON.stringify(FRAME_MODULE)};`,
);

async function startFake(source: string, hello?: { major?: number }) {
  const directory = await mkdtemp(join(tmpdir(), "connect-dsh-frames-"));
  const executable = join(directory, "dsh");
  const bridge = join(directory, "bridge.mjs");
  await Bun.write(
    executable,
    hello?.major === undefined ? source : source.replace("major: 2", `major: ${hello.major}`),
  );
  await Bun.write(bridge, "export const name = 'fake';\n");
  await chmod(executable, 0o700);
  const client = await startDshBridge({
    executable,
    executableArguments: ["--package-marker"],
    home: directory,
    cwd: directory,
    bridgePath: bridge,
    bridgeBuild: "test-build",
    startTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    stopTimeoutMs: 1_000,
  });
  return { client, directory };
}

describe("DeepSeek Harness Bridge process boundary", () => {
  it("refuses a Bridge from an older protocol major with a clear message", async () => {
    await expect(startFake(FAKE_DSH, { major: 1 })).rejects.toThrow(
      "DeepSeek Harness Bridge protocol major 1 is incompatible with 2",
    );
  });

  it("delivers a degraded oversized event, keeps the Binding Runtime, and bounds Connect requests by the hello limit", async () => {
    const { client, directory } = await startFake(FAKE_DSH_BIG);
    try {
      const events: Array<{ text: string; truncated: unknown }> = [];
      client.onEvent((frame) => {
        events.push({ text: (frame.event.data as { text: string }).text, truncated: frame.event.truncated });
      });
      await client.request("emit-big", {});
      expect(events).toHaveLength(1);
      expect(events[0]?.text).toEndWith("[output truncated: 20971520 bytes]");
      expect(events[0]?.truncated).toMatchObject({ truncated: true });
      await expect(client.request("echo", { value: 1 })).resolves.toEqual({ value: 1 });
      await expect(client.request("echo", { value: "v".repeat(DSH_BRIDGE_MAX_FRAME_BYTES + 1) })).rejects.toThrow(
        "exceeds the frame limit",
      );
      await expect(client.request("echo", { value: 2 })).resolves.toEqual({ value: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails the Binding with the size and limit when the Bridge emits a frame above the limit", async () => {
    const { client, directory } = await startFake(FAKE_DSH_BIG);
    try {
      await expect(client.request("emit-oversized", {})).rejects.toThrow(
        `emitted an oversized frame (${DSH_BRIDGE_MAX_FRAME_BYTES + 1} bytes; limit ${DSH_BRIDGE_MAX_FRAME_BYTES})`,
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("locates the CLI without version inspection and exchanges private framed RPC", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-dsh-process-"));
    const executable = join(directory, "dsh");
    const bridge = join(directory, "bridge.mjs");
    await Bun.write(executable, FAKE_DSH);
    await Bun.write(bridge, "export const name = 'fake';\n");
    await chmod(executable, 0o700);

    expect(requireDshExecutable(executable, undefined)).toEqual({ path: executable });
    const client = await startDshBridge({
      executable,
      executableArguments: ["--package-marker"],
      home: directory,
      cwd: directory,
      bridgePath: bridge,
      bridgeBuild: "test-build",
      startTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    });

    expect(client.hello).toMatchObject({
      home: directory,
      profile: null,
      protocol: { build: "test-build" },
    });
    await Bun.sleep(50);
    await expect(client.request("echo", { value: 42 })).resolves.toEqual({ value: 42 });
    await client.close();
    await expect(client.request("echo", {})).rejects.toThrow("closed");
  });

  it("reaps an unready child that ignores SIGTERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-dsh-stuck-"));
    const executable = join(directory, "dsh");
    const pidFile = join(directory, "pid");
    await Bun.write(
      executable,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    );
    await chmod(executable, 0o700);
    try {
      await expect(
        startDshBridge({
          executable,
          home: directory,
          cwd: directory,
          bridgePath: join(directory, "bridge.mjs"),
          bridgeBuild: "test-build",
          startTimeoutMs: 300,
          stopTimeoutMs: 100,
        }),
      ).rejects.toThrow("workspace-registry-missing");
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, oversized, and unsupported frames before dispatch", () => {
    expect(() => parseDshBridgeFrame("[]")).toThrow("must be an object");
    expect(() => parseDshBridgeFrame('{"type":"response","id":"1","ok":false,"error":null}')).toThrow(
      "error response is malformed",
    );
    expect(() => parseDshBridgeFrame('{"type":"event","sessionId":"s","event":{"seq":1,"time":1,"type":"x"}}')).toThrow(
      "event frame is malformed",
    );
    expect(() => parseDshBridgeFrame('{"type":"future"}')).toThrow("Unsupported DSH Bridge frame type");
    expect(
      parseDshBridgeFrame(
        '{"type":"interaction","id":"a","sessionId":"s","request":{"kind":"approval","action":"command","title":"t","description":"d","options":[]}}',
      ),
    ).toMatchObject({ type: "interaction", id: "a", sessionId: "s", request: { kind: "approval" } });
    expect(() =>
      parseDshBridgeFrame('{"type":"interaction","id":"a","sessionId":"s","request":{"kind":"future"}}'),
    ).toThrow("interaction frame is malformed");
  });

  it("prefers bunx for the official package command and uses it when dsh is not installed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-dsh-bunx-"));
    const bunx = join(directory, "bunx");
    const npx = join(directory, "npx");
    const pnpm = join(directory, "pnpm");
    await Promise.all([Bun.write(bunx, "#!/bin/sh\n"), Bun.write(npx, "#!/bin/sh\n"), Bun.write(pnpm, "#!/bin/sh\n")]);
    await Promise.all([chmod(bunx, 0o700), chmod(npx, 0o700), chmod(pnpm, 0o700)]);

    expect(requireDshPackageCommand({ PATH: directory })).toEqual({
      path: bunx,
      executableArguments: ["@deepseek-ai/dsh"],
    });
    expect(requireDshExecutable(undefined, { PATH: directory })).toEqual({
      path: bunx,
      executableArguments: ["@deepseek-ai/dsh"],
    });
  });

  it("falls back from bunx to npx", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-dsh-npx-"));
    const npx = join(directory, "npx");
    const pnpm = join(directory, "pnpm");
    await Promise.all([Bun.write(npx, "#!/bin/sh\n"), Bun.write(pnpm, "#!/bin/sh\n")]);
    await Promise.all([chmod(npx, 0o700), chmod(pnpm, 0o700)]);

    expect(requireDshPackageCommand({ PATH: directory })).toEqual({
      path: npx,
      executableArguments: ["--yes", "@deepseek-ai/dsh"],
    });
  });

  it("falls back from npx to pnpm dlx", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-dsh-pnpm-"));
    const pnpm = join(directory, "pnpm");
    await Bun.write(pnpm, "#!/bin/sh\n");
    await chmod(pnpm, 0o700);

    expect(requireDshPackageCommand({ PATH: directory })).toEqual({
      path: pnpm,
      executableArguments: ["dlx", "@deepseek-ai/dsh"],
    });
  });

  it("requires at least one supported package launcher when dsh is not installed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-dsh-no-launcher-"));
    expect(() => requireDshPackageCommand({ PATH: directory })).toThrow(
      "DeepSeek Harness package launcher was not found",
    );
  });

  it("rejects an explicitly blank executable override", () => {
    expect(() => requireDshExecutable("   ", undefined)).toThrow(
      "Configured DeepSeek Harness executable path must not be empty",
    );
  });
});
