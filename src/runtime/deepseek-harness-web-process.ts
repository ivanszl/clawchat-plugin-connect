import type { ConnectPluginManagedWebAppInstance } from "../plugin/sdk";
import {
  type LoopbackWebProcess,
  type LoopbackWebSpawnOptions,
  startSupervisedLoopbackWebApp,
} from "./loopback-web-process";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DSH_WEB_ARGUMENTS = ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"] as const;
const BRIDGE_ENVIRONMENT_NAMES = ["CONNECT_DSH_BRIDGE_FD_OUT", "CONNECT_DSH_BRIDGE_FD_IN"] as const;

export type DshWebProcess = LoopbackWebProcess;
export type DshWebSpawnOptions = LoopbackWebSpawnOptions;

export interface StartDshWebAppOptions {
  readonly executable: string;
  readonly executableArguments?: readonly string[];
  readonly home: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly readinessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawnProcess?: (executable: string, args: readonly string[], options: DshWebSpawnOptions) => DshWebProcess;
}

export function canonicalDshWebEnvironmentOverrides(
  home: string,
  env: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = { ...env, DSH_HOME: home };
  for (const name of BRIDGE_ENVIRONMENT_NAMES) delete overrides[name];
  return Object.freeze(
    Object.fromEntries(Object.entries(overrides).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
  );
}

export async function startDshWebApp(options: StartDshWebAppOptions): Promise<ConnectPluginManagedWebAppInstance> {
  return await startSupervisedLoopbackWebApp({
    label: "DSH Web",
    executable: options.executable,
    args: [...(options.executableArguments ?? []), ...DSH_WEB_ARGUMENTS],
    env: {
      ...process.env,
      ...canonicalDshWebEnvironmentOverrides(options.home, options.env),
    },
    readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
  });
}
