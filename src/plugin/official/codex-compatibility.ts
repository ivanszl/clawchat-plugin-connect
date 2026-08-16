import { spawnSync } from "node:child_process";

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
