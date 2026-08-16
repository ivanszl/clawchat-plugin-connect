import { spawn, spawnSync } from "node:child_process";
import { parseOpenCodeVersion } from "../../runtime/opencode-version";
import type { ConnectPluginRuntimeProbeContext, ConnectPluginRuntimeProbeResult } from "../sdk";

export interface CompatibleOpenCodeExecutable {
  readonly path: string;
  readonly version: string;
}

export function requireCompatibleOpenCodeExecutable(
  configuredPath: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): CompatibleOpenCodeExecutable {
  const configuredExecutable = configuredPath?.trim();
  if (configuredPath !== undefined && !configuredExecutable) {
    throw new Error("Configured OpenCode executable path must not be empty");
  }
  const executable = configuredExecutable ?? Bun.which("opencode", { PATH: env?.PATH ?? process.env.PATH });
  if (!executable) {
    throw new Error(
      "OpenCode executable was not found in PATH; install OpenCode CLI or configure executablePathOverride",
    );
  }
  const result = spawnSync(executable, ["--version"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw new Error(`OpenCode executable could not be started: ${executable}`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(
      `OpenCode version probe exited with code ${result.status ?? "unknown"}: ${result.stderr.trim() || "no error output"}`,
    );
  }
  const version = parseOpenCodeVersion(result.stdout);
  return { path: executable, version };
}

export async function probeCompatibleOpenCodeExecutable(
  context: ConnectPluginRuntimeProbeContext,
): Promise<ConnectPluginRuntimeProbeResult> {
  const executable = await context.findExecutable("opencode");
  if (!executable) {
    return {
      detected: false,
      compatible: false,
      detail: "OpenCode executable was not found in PATH",
    };
  }

  const child = spawn(executable, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
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

  const exited = Promise.withResolvers<number | null>();
  child.once("error", exited.reject);
  child.once("exit", exited.resolve);
  let code: number | null;
  try {
    code = await exited.promise;
  } catch (error) {
    return {
      detected: true,
      compatible: false,
      path: executable,
      detail: `OpenCode executable could not be started: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (code !== 0) {
    return {
      detected: true,
      compatible: false,
      path: executable,
      detail: `OpenCode version probe exited with code ${code ?? "unknown"}: ${stderr.trim() || "no error output"}`,
    };
  }

  try {
    const version = parseOpenCodeVersion(stdout);
    return {
      detected: true,
      compatible: true,
      path: executable,
      version,
    };
  } catch (error) {
    return {
      detected: true,
      compatible: false,
      path: executable,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
