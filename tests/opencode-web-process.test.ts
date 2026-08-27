import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  type OpenCodeWebProcess,
  openCodeWebLaunchConfiguration,
  startOpenCodeWebApp,
} from "../src/runtime/opencode-web-process";

describe("OpenCode Web process boundary", () => {
  it("uses the official Web invocation, preserves upstream auth, and removes launch routing overrides", () => {
    const launch = openCodeWebLaunchConfiguration("/opt/opencode", {
      BROWSER: "true",
      OPENCODE_SERVER_PASSWORD: "web-secret",
      OPENCODE_SERVER_USERNAME: "web-user",
      OPENCODE_SERVER_PORT: "9999",
      SAFE_VALUE: "kept",
    });

    expect(launch).toMatchObject({
      executable: "/opt/opencode",
      args: ["web", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"],
      env: {
        SAFE_VALUE: "kept",
        OPENCODE_SERVER_PASSWORD: "web-secret",
        OPENCODE_SERVER_USERNAME: "web-user",
      },
    });
    expect(launch.args[0]).not.toBe("serve");
    expect(launch.env.BROWSER).toBeUndefined();
    expect(launch.env.OPENCODE_SERVER_PASSWORD).toBe("web-secret");
    expect(launch.env.OPENCODE_SERVER_USERNAME).toBe("web-user");
    expect(launch.env.OPENCODE_SERVER_PORT).toBeUndefined();
  });

  it("supervises the Web server independently after its incidental browser opens", async () => {
    const child = new FakeOpenCodeWebProcess();
    child.onKill = (signal) => {
      if (signal === "SIGTERM") queueMicrotask(() => child.exit(0, "SIGTERM"));
    };
    let launch: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    const app = await startOpenCodeWebApp({
      executable: { path: "/opt/opencode", version: "1.18.16" },
      env: { OPENCODE_SERVER_PASSWORD: "web-secret", SAFE_VALUE: "kept" },
      spawnProcess(executable, args, options) {
        launch = { executable, args, env: options.env };
        queueMicrotask(() => child.stdout.write("OpenCode Web: http://127.0.0.1:43128/\n"));
        return child;
      },
    });

    expect(launch).toMatchObject({
      executable: "/opt/opencode",
      args: ["web", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"],
      env: { SAFE_VALUE: "kept", OPENCODE_SERVER_PASSWORD: "web-secret" },
    });
    expect(launch?.env.OPENCODE_SERVER_PASSWORD).toBe("web-secret");
    expect(app.upstream).toBe("http://127.0.0.1:43128");
    expect(app.health()).toBe("ready");
    expect(child.exitCode).toBeNull();

    await app.release();
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(app.health()).toBe("stopped");
  });

  it("reports unexpected Web process exit without affecting Runtime ownership", async () => {
    const child = new FakeOpenCodeWebProcess();
    const app = await startOpenCodeWebApp({
      executable: { path: "/opt/opencode", version: "1.18.16" },
      spawnProcess() {
        queueMicrotask(() => child.stderr.write("listening at http://127.0.0.1:43129\n"));
        return child;
      },
    });
    const exits: unknown[] = [];
    app.onExit((error) => exits.push(error));

    child.exit(7, null);

    expect(app.health()).toBe("error");
    expect(exits).toEqual([expect.objectContaining({ message: expect.stringContaining("code 7") })]);
  });
});

class FakeOpenCodeWebProcess extends EventEmitter implements OpenCodeWebProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  onKill?: (signal: NodeJS.Signals | number | undefined) => void;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    this.onKill?.(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
}
