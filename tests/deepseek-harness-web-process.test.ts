import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type DshWebProcess, startDshWebApp } from "../src/runtime/deepseek-harness-web-process";

describe("DSH Web process boundary", () => {
  it("uses only the official Web argv, isolates Bridge environment, and reports readiness and exit", async () => {
    const child = new FakeDshWebProcess();
    let launch: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    const app = await startDshWebApp({
      executable: "/opt/dsh",
      home: "/homes/alpha",
      env: {
        TEST_WEB_ENV: "present",
        CONNECT_DSH_BRIDGE_FD_OUT: "77",
        CONNECT_DSH_BRIDGE_FD_IN: "78",
      },
      spawnProcess(executable, args, options) {
        launch = { executable, args, env: options.env };
        queueMicrotask(() => child.stdout.write("DSH Web listening at http://127.0.0.1:43127/\n"));
        return child;
      },
    });

    expect(launch).toMatchObject({
      executable: "/opt/dsh",
      args: ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"],
      env: { DSH_HOME: "/homes/alpha", TEST_WEB_ENV: "present" },
    });
    expect(launch?.args).not.toContain("--patch");
    expect(launch?.env.CONNECT_DSH_BRIDGE_FD_OUT).toBeUndefined();
    expect(launch?.env.CONNECT_DSH_BRIDGE_FD_IN).toBeUndefined();
    expect(app.upstream).toBe("http://127.0.0.1:43127");
    expect(app.health()).toBe("ready");

    const health: string[] = [];
    const exits: unknown[] = [];
    app.onHealthChange((value) => health.push(value));
    app.onExit((error) => exits.push(error));
    child.exit(17, null);
    expect(app.health()).toBe("error");
    expect(health).toEqual(["error"]);
    expect(exits).toEqual([expect.objectContaining({ message: expect.stringContaining("code 17") })]);
  });

  it("stops once on idempotent release and escalates within the shutdown bound", async () => {
    const graceful = new FakeDshWebProcess();
    graceful.onKill = (signal) => {
      if (signal === "SIGTERM") queueMicrotask(() => graceful.exit(0, "SIGTERM"));
    };
    const gracefulApp = await startDshWebApp({
      executable: "/opt/dsh",
      home: "/homes/graceful",
      spawnProcess() {
        queueMicrotask(() => graceful.stdout.write("http://127.0.0.1:41001\n"));
        return graceful;
      },
    });
    await Promise.all([gracefulApp.release(), gracefulApp.release()]);
    expect(graceful.kills).toEqual(["SIGTERM"]);
    expect(gracefulApp.health()).toBe("stopped");

    const stuck = new FakeDshWebProcess();
    const stuckApp = await startDshWebApp({
      executable: "/opt/dsh",
      home: "/homes/stuck",
      shutdownTimeoutMs: 1,
      spawnProcess() {
        queueMicrotask(() => stuck.stdout.write("http://127.0.0.1:41002\n"));
        return stuck;
      },
    });
    await expect(stuckApp.release()).rejects.toThrow("DSH Web did not exit after SIGKILL");
    expect(stuck.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stuckApp.health()).toBe("error");
  });

  it("rejects an early process exit instead of reporting false readiness", async () => {
    const child = new FakeDshWebProcess();
    const starting = startDshWebApp({
      executable: "/opt/dsh",
      home: "/homes/failed",
      spawnProcess() {
        queueMicrotask(() => child.exit(2, null));
        return child;
      },
    });
    await expect(starting).rejects.toThrow("DSH Web exited unexpectedly with code 2");
  });
});

const installedDsh = Bun.which("dsh");
describe("installed DSH Web smoke", () => {
  if (!installedDsh) {
    it.skip("environment-blocked: the DSH executable is absent from PATH", () => {});
    return;
  }

  it("starts the installed official Web entrypoint on loopback and stops it", async () => {
    const home = await mkdtemp(join(tmpdir(), "connect-dsh-web-smoke-"));
    const app = await startDshWebApp({
      executable: installedDsh,
      home,
      readinessTimeoutMs: 10_000,
      shutdownTimeoutMs: 5_000,
    });
    try {
      expect(app.upstream).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(app.health()).toBe("ready");
    } finally {
      await app.release();
    }
  });
});

class FakeDshWebProcess extends EventEmitter implements DshWebProcess {
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
