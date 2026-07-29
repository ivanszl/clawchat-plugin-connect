import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const REPOSITORY = "clawling/clawchat-plugin-connect";

export interface UpdateConnectOptions {
  version?: string;
  configPath?: string;
  fetch?: typeof globalThis.fetch;
  executablePath?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  runCommand?: UpdateCommandRunner;
}

export interface UpdateConnectResult {
  version: string;
  executablePath: string;
}

export type UpdateCommandRunner = (command: string[], environment?: NodeJS.ProcessEnv) => Promise<void>;

export async function updateConnect(options: UpdateConnectOptions = {}): Promise<UpdateConnectResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(`Connect update is unsupported on ${platform}`);
  }
  const environment = options.environment ?? process.env;
  const executablePath = options.executablePath ?? process.execPath;
  const installDirectory = resolveInstallDirectory(executablePath, platform, environment);
  const version = normalizeVersion(options.version);
  const fetchInstaller = options.fetch ?? globalThis.fetch;
  const runCommand = options.runCommand ?? runUpdateCommand;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "clawchat-connect-update-"));
  try {
    const windows = platform === "win32";
    if (!windows && isConnectExecutable(executablePath)) {
      await runCommand([
        executablePath,
        "service",
        "stop",
        ...(options.configPath ? ["--config", options.configPath] : []),
      ]).catch(() => undefined);
    }
    const installerName = windows ? "install.ps1" : "install.sh";
    const installerUrl = `https://raw.githubusercontent.com/${REPOSITORY}/main/${installerName}`;
    const response = await fetchInstaller(installerUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Could not download the Connect installer (HTTP ${response.status})`);
    const installerPath = join(temporaryDirectory, installerName);
    await Bun.write(installerPath, await response.arrayBuffer());
    const installerCommand = windows
      ? [
          "powershell",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          installerPath,
          ...(version ? ["-Version", version] : []),
          "-InstallDirectory",
          installDirectory,
        ]
      : ["sh", installerPath, ...(version ? [version] : [])];
    await runCommand(installerCommand, {
      ...environment,
      CLAWCHAT_CONNECT_INSTALL_DIR: installDirectory,
    });
    const installedExecutable = join(installDirectory, windows ? "clawchat-connect.exe" : "clawchat-connect");
    await runCommand([
      installedExecutable,
      "service",
      "install",
      ...(options.configPath ? ["--config", options.configPath] : []),
    ]);
    return { version: version || "latest", executablePath: installedExecutable };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function isConnectExecutable(executablePath: string): boolean {
  const executableName = basename(executablePath).toLowerCase();
  return executableName === "clawchat-connect" || executableName === "clawchat-connect.exe";
}

function resolveInstallDirectory(
  executablePath: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (isConnectExecutable(executablePath)) {
    return dirname(executablePath);
  }
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is required to update Connect on Windows");
    return join(localAppData, "ClawChatConnect", "bin");
  }
  return join(homedir(), ".local", "bin");
}

function normalizeVersion(value: string | undefined): string {
  const version = value?.trim() ?? "";
  if (!version) return "";
  const normalized = version.startsWith("v") ? version : `v${version}`;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`Invalid Connect release version: ${value}`);
  }
  return normalized;
}

async function runUpdateCommand(command: string[], environment?: NodeJS.ProcessEnv): Promise<void> {
  const child = Bun.spawn(command, {
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Connect update command failed with exit ${code}: ${command[0]}`);
}
