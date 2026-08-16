import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import type { ConnectPluginRuntimeProbeContext, ConnectPluginRuntimeProbeResult } from "../sdk";

const CODEX_VERSION_OUTPUT =
  /^codex-cli (?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface CompatibleCodexExecutable {
  readonly path: string;
  readonly version: string;
}

export function requireCompatibleCodexExecutable(
  configuredPath: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): CompatibleCodexExecutable {
  const executable = configuredPath?.trim() || Bun.which("codex", { PATH: env?.PATH ?? process.env.PATH });
  if (!executable) {
    throw new Error("Codex executable was not found; clawling.runtime.codex requires codex in PATH or executablePath");
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
  if (!CODEX_VERSION_OUTPUT.test(version)) {
    throw new Error(
      `Malformed Codex version output from ${executable}: expected codex-cli <semantic version>, received ${version || "empty output"}`,
    );
  }
  return { path: executable, version };
}

export async function probeCompatibleCodexExecutable(
  context: ConnectPluginRuntimeProbeContext,
): Promise<ConnectPluginRuntimeProbeResult> {
  const executable = await context.findExecutable("codex");
  if (!executable) {
    return {
      detected: false,
      compatible: false,
      detail: "Codex was not found in PATH",
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
    [code] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
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
  if (!CODEX_VERSION_OUTPUT.test(version)) {
    return {
      detected: true,
      compatible: false,
      version,
      path: executable,
      detail: `Malformed Codex version output from ${executable}: expected codex-cli <semantic version>, received ${version || "empty output"}`,
    };
  }
  return {
    detected: true,
    compatible: true,
    version,
    path: executable,
    detail: `Detected ${version} at ${executable}; app-server compatibility will be verified during startup`,
  };
}
