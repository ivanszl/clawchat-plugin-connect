import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import type { ConnectPluginRuntimeProbeContext, ConnectPluginRuntimeProbeResult } from "../sdk";

export const SUPPORTED_CODEX_VERSION = "0.145.0" as const;
export const SUPPORTED_CODEX_VERSION_OUTPUT = `codex-cli ${SUPPORTED_CODEX_VERSION}` as const;

export interface CompatibleCodexExecutable {
  readonly path: string;
  readonly version: typeof SUPPORTED_CODEX_VERSION_OUTPUT;
}

export function requireCompatibleCodexExecutable(
  configuredPath: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): CompatibleCodexExecutable {
  const executable = configuredPath?.trim() || Bun.which("codex", { PATH: env?.PATH ?? process.env.PATH });
  if (!executable) {
    throw new Error(
      `Codex executable was not found; clawling.runtime.codex requires exactly ${SUPPORTED_CODEX_VERSION_OUTPUT}`,
    );
  }
  const result = spawnSync(executable, ["--version"], {
    env: env ? { ...process.env, ...env } : undefined,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error) {
    throw new Error(`Failed to inspect configured Codex executable ${executable}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  const version = (result.stdout ?? "").trim();
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || version || `exit ${String(result.status)}`;
    throw new Error(`Failed to inspect configured Codex executable ${executable}: ${detail}`);
  }
  if (version !== SUPPORTED_CODEX_VERSION_OUTPUT) {
    throw new Error(
      `Unsupported Codex executable ${executable}: expected exactly ${SUPPORTED_CODEX_VERSION_OUTPUT}, received ${version || "empty version output"}`,
    );
  }
  return { path: executable, version: SUPPORTED_CODEX_VERSION_OUTPUT };
}

export async function probeCompatibleCodexExecutable(
  context: ConnectPluginRuntimeProbeContext,
): Promise<ConnectPluginRuntimeProbeResult> {
  const executable = await context.findExecutable("codex");
  if (!executable) {
    return {
      detected: false,
      compatible: false,
      detail: `Codex was not found in PATH; this Plugin requires exactly ${SUPPORTED_CODEX_VERSION_OUTPUT}`,
    };
  }
  const child = spawn(executable, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 5_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let code: number | null;
  try {
    [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  } catch (error) {
    return {
      detected: true,
      compatible: false,
      path: executable,
      detail: `Failed to inspect Codex executable ${executable}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const version = stdout.trim();
  if (code !== 0) {
    return {
      detected: true,
      compatible: false,
      path: executable,
      ...(version ? { version } : {}),
      detail: `Failed to inspect Codex executable ${executable}: ${stderr.trim() || version || `exit ${String(code)}`}`,
    };
  }
  const compatible = version === SUPPORTED_CODEX_VERSION_OUTPUT;
  return {
    detected: true,
    compatible,
    version,
    path: executable,
    detail: compatible
      ? `Detected supported ${SUPPORTED_CODEX_VERSION_OUTPUT} at ${executable}`
      : `Unsupported Codex executable ${executable}: expected exactly ${SUPPORTED_CODEX_VERSION_OUTPUT}, received ${version || "empty version output"}`,
  };
}
