import { spawnSync } from "node:child_process";
import { parseOpenCodeVersion } from "../../runtime/opencode-version";

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
