import type { CompatibleOpenCodeExecutable } from "../plugin/official/opencode-compatibility";
import type { ConnectPluginManagedWebAppInstance } from "../plugin/sdk";
import {
  type LoopbackWebProcess,
  type LoopbackWebSpawnOptions,
  startSupervisedLoopbackWebApp,
} from "./loopback-web-process";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_WEB_ARGUMENTS = ["web", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"] as const;
const NON_WEB_SERVICE_ENVIRONMENT_NAMES = [
  "BROWSER",
  "OPENCODE_SERVER_HOSTNAME",
  "OPENCODE_SERVER_PORT",
  "OPENCODE_SERVER_CORS",
  "OPENCODE_SERVER_MDNS",
] as const;

export type OpenCodeWebProcess = LoopbackWebProcess;
export type OpenCodeWebSpawnOptions = LoopbackWebSpawnOptions;

export interface OpenCodeWebLaunchConfiguration {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface StartOpenCodeWebAppOptions {
  readonly executable: CompatibleOpenCodeExecutable;
  readonly env?: Readonly<Record<string, string>>;
  readonly readinessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: OpenCodeWebSpawnOptions,
  ) => OpenCodeWebProcess;
}

/**
 * OpenCode Web opens the operator's default browser once during startup. The
 * browser is incidental: OpenCode keeps the supervised Web server alive after
 * that browser closes, so Connect follows the process rather than the browser.
 */
export function openCodeWebLaunchConfiguration(
  executable: string,
  env: Readonly<Record<string, string>> | undefined,
): OpenCodeWebLaunchConfiguration {
  const webEnvironment: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of NON_WEB_SERVICE_ENVIRONMENT_NAMES) delete webEnvironment[name];
  return {
    executable,
    args: OPENCODE_WEB_ARGUMENTS,
    env: webEnvironment,
  };
}

export async function startOpenCodeWebApp(
  options: StartOpenCodeWebAppOptions,
): Promise<ConnectPluginManagedWebAppInstance> {
  const launch = openCodeWebLaunchConfiguration(options.executable.path, options.env);
  return await startSupervisedLoopbackWebApp({
    label: "OpenCode Web",
    executable: launch.executable,
    args: launch.args,
    env: launch.env,
    readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
  });
}
