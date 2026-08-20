import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireDshExecutable, startDshBridge } from "../src/runtime/deepseek-harness-process";
import { parseDshBridgeFrame } from "../src/runtime/deepseek-harness-protocol";

const FAKE_DSH = `#!/usr/bin/env bun
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const patchIndex = process.argv.indexOf("--patch");
const patch = readFileSync(process.argv[patchIndex + 1], "utf8");
const config = Object.fromEntries(
  [...patch.matchAll(/^\\s+(build|home|profile): (.+)$/gm)].map((match) => [match[1], JSON.parse(match[2])]),
);
const output = createWriteStream(null, { fd: 3 });
const input = createReadStream(null, { fd: 4 });
output.write(JSON.stringify({
  type: "hello",
  protocol: { name: "clawchat-connect-dsh-bridge", major: 1, build: config.build },
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
const lines = createInterface({ input, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  output.write(JSON.stringify({ type: "response", id: request.id, ok: true, result: request.params }) + "\\n");
});
`;

describe("DeepSeek Harness Bridge process boundary", () => {
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
    await expect(client.request("echo", { value: 42 })).resolves.toEqual({ value: 42 });
    await client.close();
    await expect(client.request("echo", {})).rejects.toThrow("closed");
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

  it("rejects an explicitly blank executable override", () => {
    expect(() => requireDshExecutable("   ", undefined)).toThrow(
      "Configured DeepSeek Harness executable path must not be empty",
    );
  });
});
