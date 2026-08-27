import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  ConnectPluginDisposer,
  ConnectPluginManagedWebAppInstance,
  ManagedWebAppHealth,
} from "../plugin/sdk";

const MAX_OUTPUT_BYTES = 65_536;

export interface LoopbackWebProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LoopbackWebSpawnOptions {
  env: NodeJS.ProcessEnv;
  windowsHide: true;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface StartSupervisedLoopbackWebAppOptions {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly readinessTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: LoopbackWebSpawnOptions,
  ) => LoopbackWebProcess;
}

export async function startSupervisedLoopbackWebApp(
  options: StartSupervisedLoopbackWebAppOptions,
): Promise<ConnectPluginManagedWebAppInstance> {
  const child = (options.spawnProcess ?? spawnLoopbackWebProcess)(options.executable, options.args, {
    env: options.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const instance = new SpawnedLoopbackWebApp(
    options.label,
    child,
    options.readinessTimeoutMs,
    options.shutdownTimeoutMs,
  );
  try {
    await instance.waitUntilReady();
    return instance;
  } catch (error) {
    await instance.release();
    throw error;
  }
}

class SpawnedLoopbackWebApp implements ConnectPluginManagedWebAppInstance {
  private readonly healthListeners = new Set<(health: ManagedWebAppHealth) => void>();
  private readonly exitListeners = new Set<(error?: unknown) => void>();
  private readonly exited: Promise<void>;
  private readonly ready: Promise<void>;
  private origin: string | null = null;
  private currentHealth: ManagedWebAppHealth = "starting";
  private output = "";
  private stopping = false;
  private didExit = false;
  private settleExit!: () => void;
  private settleReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private releasePromise: Promise<void> | null = null;

  constructor(
    private readonly label: string,
    private readonly child: LoopbackWebProcess,
    readinessTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
  ) {
    if (!child.stdout || !child.stderr) throw new Error(`${label} process pipes were not created`);
    this.exited = new Promise<void>((resolve) => {
      this.settleExit = resolve;
    });
    const boot = new Promise<void>((resolve, reject) => {
      this.settleReady = resolve;
      this.rejectReady = reject;
    });
    this.ready = withTimeout(
      boot,
      readinessTimeoutMs,
      `${label} did not report a loopback URL before startup timed out`,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receiveOutput(chunk));
    child.stderr.on("data", (chunk: string) => this.receiveOutput(chunk));
    child.once("error", (cause) =>
      this.processFailed(new Error(`${label} process could not be started`, { cause })),
    );
    child.once("exit", (code, signal) => this.processExited(code, signal));
  }

  get upstream(): string {
    if (!this.origin) throw new Error(`${this.label} has not reported its loopback URL`);
    return this.origin;
  }

  async waitUntilReady(): Promise<void> {
    await this.ready;
  }

  health(): ManagedWebAppHealth {
    return this.currentHealth;
  }

  onHealthChange(listener: (health: ManagedWebAppHealth) => void): ConnectPluginDisposer {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  onExit(listener: (error?: unknown) => void): ConnectPluginDisposer {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async release(): Promise<void> {
    if (!this.releasePromise) this.releasePromise = this.stop();
    const operation = this.releasePromise;
    try {
      await operation;
    } catch (error) {
      if (this.releasePromise === operation) this.releasePromise = null;
      throw error;
    }
  }

  private receiveOutput(chunk: string): void {
    this.output = `${this.output}${chunk}`.slice(-MAX_OUTPUT_BYTES);
    if (this.origin || this.didExit) return;
    const match = /http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/)?(?=$|[\s"'])/u.exec(this.output);
    if (!match) return;
    const port = Number(match[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return;
    this.origin = `http://127.0.0.1:${port}`;
    this.transition("ready");
    this.settleReady();
  }

  private processFailed(error: Error): void {
    if (this.didExit) return;
    this.didExit = true;
    this.rejectReady(error);
    this.transition("error");
    this.settleExit();
    for (const listener of this.exitListeners) listener(error);
  }

  private processExited(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.didExit) return;
    this.didExit = true;
    const detail = this.output.trim();
    const error = this.stopping
      ? undefined
      : new Error(
          `${this.label} exited unexpectedly${
            code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : ""
          }${detail ? `: ${detail}` : ""}`,
        );
    if (error) this.rejectReady(error);
    this.transition(error ? "error" : "stopped");
    this.settleExit();
    for (const listener of this.exitListeners) listener(error);
  }

  private transition(health: ManagedWebAppHealth): void {
    if (this.currentHealth === health) return;
    this.currentHealth = health;
    for (const listener of this.healthListeners) listener(health);
  }

  private async stop(): Promise<void> {
    if (this.didExit || this.child.exitCode !== null) return;
    this.stopping = true;
    this.child.kill("SIGTERM");
    const exited = await settlesWithin(this.exited, this.shutdownTimeoutMs);
    if (exited || this.didExit || this.child.exitCode !== null) return;
    this.child.kill("SIGKILL");
    const killed = await settlesWithin(this.exited, this.shutdownTimeoutMs);
    if (killed || this.didExit || this.child.exitCode !== null) return;
    this.transition("error");
    throw new Error(`${this.label} did not exit after SIGKILL`);
  }
}

function spawnLoopbackWebProcess(
  executable: string,
  args: readonly string[],
  options: LoopbackWebSpawnOptions,
): LoopbackWebProcess {
  return spawn(executable, [...args], options);
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
