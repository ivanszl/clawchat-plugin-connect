import { existsSync } from "node:fs";
import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type BackgroundServiceAction = "install" | "start" | "stop" | "restart" | "status" | "logs";
export const BACKGROUND_SERVICE_PROCESS_ACTION = "exec" as const;

export interface BackgroundServiceRequest {
  action: BackgroundServiceAction;
  configPath: string;
  command?: string[];
  lines?: number;
  follow?: boolean;
}

export interface BackgroundServiceResult {
  message: string;
  running?: boolean;
}

export interface BackgroundCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BackgroundServiceDependencies {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  uid?: number;
  pathEnvironment?: string;
  runCommand?: (command: string[], inheritOutput?: boolean) => Promise<BackgroundCommandResult>;
}

interface ServiceDefinition {
  command: string[];
  label: string;
  unitName: string;
  launchAgentPath: string;
  systemdUnitPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export async function manageBackgroundService(
  request: BackgroundServiceRequest,
  dependencies: BackgroundServiceDependencies = {},
): Promise<BackgroundServiceResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`background services are not supported on ${platform}`);
  }
  const definition = createServiceDefinition(request, dependencies.homeDirectory ?? homedir());
  const runCommand = dependencies.runCommand ?? runBackgroundCommand;
  if (platform === "darwin") {
    const uid = dependencies.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("could not determine the current macOS user id");
    return await manageLaunchAgent(
      request,
      definition,
      uid,
      dependencies.pathEnvironment ?? process.env.PATH ?? "",
      runCommand,
    );
  }
  return await manageSystemdUserService(
    request,
    definition,
    dependencies.pathEnvironment ?? process.env.PATH ?? "",
    runCommand,
  );
}

export function currentConnectCommand(): string[] {
  const executable = resolve(process.execPath);
  const entrypoint = resolve(Bun.main);
  return executable === entrypoint ? [executable] : [executable, entrypoint];
}

function createServiceDefinition(request: BackgroundServiceRequest, homeDirectory: string): ServiceDefinition {
  const configPath = resolve(requireServiceValue(request.configPath, "config path"));
  const command = (request.command ?? currentConnectCommand()).map((value, index) =>
    requireServiceValue(value, `command argument ${index + 1}`),
  );
  if (command.length === 0) throw new Error("background service command is required");
  const logsDirectory = join(homeDirectory, ".clawchat-connect", "logs");
  return {
    command: [...command, "service", BACKGROUND_SERVICE_PROCESS_ACTION, "--config", configPath],
    label: "com.clawchat.connect",
    unitName: "clawchat-connect.service",
    launchAgentPath: join(homeDirectory, "Library", "LaunchAgents", "com.clawchat.connect.plist"),
    systemdUnitPath: join(homeDirectory, ".config", "systemd", "user", "clawchat-connect.service"),
    stdoutPath: join(logsDirectory, "service.log"),
    stderrPath: join(logsDirectory, "service.error.log"),
  };
}

async function manageLaunchAgent(
  request: BackgroundServiceRequest,
  definition: ServiceDefinition,
  uid: number,
  pathEnvironment: string,
  runCommand: NonNullable<BackgroundServiceDependencies["runCommand"]>,
): Promise<BackgroundServiceResult> {
  const domain = `gui/${uid}`;
  const target = `${domain}/${definition.label}`;
  if (request.action === "install") {
    await writeManagedFile(definition.launchAgentPath, launchAgentPlist(definition, pathEnvironment));
    await ensureLogFiles(definition);
    await runCommand(["launchctl", "bootout", target]);
    await runRequired(runCommand, ["launchctl", "enable", target]);
    await runRequired(runCommand, ["launchctl", "bootstrap", domain, definition.launchAgentPath]);
    return { message: installedMessage("launchd", definition.launchAgentPath), running: true };
  }
  if (request.action === "status") {
    const status = await runCommand(["launchctl", "print", target]);
    return serviceStatus("launchd", definition, status.exitCode === 0);
  }
  if (request.action === "logs") return await launchAgentLogs(request, definition, runCommand);
  requireInstalled(definition.launchAgentPath);
  if (request.action === "stop") {
    const stopped = await runCommand(["launchctl", "bootout", target]);
    if (stopped.exitCode !== 0 && !isNotLoaded(stopped)) throw commandError(stopped, ["launchctl", "bootout", target]);
    return { message: "Stopped ClawChat Connect background service.\n", running: false };
  }
  const loaded = (await runCommand(["launchctl", "print", target])).exitCode === 0;
  if (!loaded) await runRequired(runCommand, ["launchctl", "bootstrap", domain, definition.launchAgentPath]);
  await runRequired(runCommand, ["launchctl", "kickstart", "-k", target]);
  const verb = request.action === "restart" ? "Restarted" : "Started";
  return { message: `${verb} ClawChat Connect background service.\n`, running: true };
}

async function manageSystemdUserService(
  request: BackgroundServiceRequest,
  definition: ServiceDefinition,
  pathEnvironment: string,
  runCommand: NonNullable<BackgroundServiceDependencies["runCommand"]>,
): Promise<BackgroundServiceResult> {
  if (request.action === "install") {
    await writeManagedFile(definition.systemdUnitPath, systemdUnit(definition, pathEnvironment));
    await runRequired(runCommand, ["systemctl", "--user", "daemon-reload"]);
    await runRequired(runCommand, ["systemctl", "--user", "enable", "--now", definition.unitName]);
    return { message: installedMessage("systemd", definition.systemdUnitPath), running: true };
  }
  if (request.action === "status") {
    const status = await runCommand(["systemctl", "--user", "is-active", definition.unitName]);
    return serviceStatus("systemd", definition, status.exitCode === 0 && status.stdout.trim() === "active");
  }
  if (request.action === "logs") {
    const lines = normalizeLogLines(request.lines);
    const command = ["journalctl", "--user", "--unit", definition.unitName, "--lines", String(lines)];
    if (request.follow) command.push("--follow");
    const result = await runCommand(command, request.follow === true);
    if (result.exitCode !== 0) throw commandError(result, command);
    return { message: request.follow ? "Log stream ended.\n" : result.stdout || "No service logs.\n" };
  }
  requireInstalled(definition.systemdUnitPath);
  const action = request.action === "restart" ? "restart" : request.action;
  await runRequired(runCommand, ["systemctl", "--user", action, definition.unitName]);
  const verb = request.action === "restart" ? "Restarted" : request.action === "start" ? "Started" : "Stopped";
  return {
    message: `${verb} ClawChat Connect background service.\n`,
    running: request.action !== "stop",
  };
}

async function launchAgentLogs(
  request: BackgroundServiceRequest,
  definition: ServiceDefinition,
  runCommand: NonNullable<BackgroundServiceDependencies["runCommand"]>,
): Promise<BackgroundServiceResult> {
  const paths = [definition.stdoutPath, definition.stderrPath].filter((path) => existsSync(path));
  if (paths.length === 0) return { message: "No service logs.\n" };
  const command = ["tail", "-n", String(normalizeLogLines(request.lines))];
  if (request.follow) command.push("-f");
  command.push(...paths);
  const result = await runCommand(command, request.follow === true);
  if (result.exitCode !== 0) throw commandError(result, command);
  return { message: request.follow ? "Log stream ended.\n" : result.stdout || "No service logs.\n" };
}

function launchAgentPlist(definition: ServiceDefinition, pathEnvironment: string): string {
  const argumentsXml = definition.command.map((argument) => `      <string>${xmlEscape(argument)}</string>`).join("\n");
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${definition.label}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argumentsXml,
    "    </array>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "      <key>PATH</key>",
    `      <string>${xmlEscape(pathEnvironment)}</string>`,
    "    </dict>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ThrottleInterval</key>",
    "    <integer>5</integer>",
    "    <key>StandardOutPath</key>",
    `    <string>${xmlEscape(definition.stdoutPath)}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xmlEscape(definition.stderrPath)}</string>`,
    "  </dict>",
    "</plist>",
  ].join("\n")}\n`;
}

function systemdUnit(definition: ServiceDefinition, pathEnvironment: string): string {
  return `${[
    "[Unit]",
    "Description=ClawChat Connect",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${definition.command.map(systemdQuote).join(" ")}`,
    `Environment=${systemdQuote(`PATH=${pathEnvironment}`)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n")}\n`;
}

async function writeManagedFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function ensureLogFiles(definition: ServiceDefinition): Promise<void> {
  await mkdir(dirname(definition.stdoutPath), { recursive: true, mode: 0o700 });
  await Promise.all(
    [definition.stdoutPath, definition.stderrPath].map(async (path) => {
      const handle = await open(path, "a", 0o600);
      await handle.close();
      await chmod(path, 0o600).catch(() => undefined);
    }),
  );
}

async function runBackgroundCommand(command: string[], inheritOutput = false): Promise<BackgroundCommandResult> {
  const child = Bun.spawn(command, {
    stdin: inheritOutput ? "inherit" : "ignore",
    stdout: inheritOutput ? "inherit" : "pipe",
    stderr: inheritOutput ? "inherit" : "pipe",
  });
  const stdout = inheritOutput ? Promise.resolve("") : new Response(child.stdout).text();
  const stderr = inheritOutput ? Promise.resolve("") : new Response(child.stderr).text();
  const [exitCode, capturedStdout, capturedStderr] = await Promise.all([child.exited, stdout, stderr]);
  return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
}

async function runRequired(
  runCommand: NonNullable<BackgroundServiceDependencies["runCommand"]>,
  command: string[],
): Promise<BackgroundCommandResult> {
  const result = await runCommand(command);
  if (result.exitCode !== 0) throw commandError(result, command);
  return result;
}

function commandError(result: BackgroundCommandResult, command: string[]): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return new Error(`${command[0]} failed: ${detail}`);
}

function isNotLoaded(result: BackgroundCommandResult): boolean {
  return /could not find|not found|no such process|service is not loaded/iu.test(`${result.stdout}\n${result.stderr}`);
}

function installedMessage(manager: string, path: string): string {
  return `Installed and started ClawChat Connect background service with ${manager}.\nDefinition: ${path}\n`;
}

function serviceStatus(manager: string, definition: ServiceDefinition, running: boolean): BackgroundServiceResult {
  const path = manager === "launchd" ? definition.launchAgentPath : definition.systemdUnitPath;
  return {
    message: `${[
      "ClawChat Connect background service",
      `manager: ${manager}`,
      `state: ${running ? "running" : "stopped"}`,
      `definition: ${path}`,
    ].join("\n")}\n`,
    running,
  };
}

function requireInstalled(path: string): void {
  if (!existsSync(path))
    throw new Error(`background service is not installed; run \`clawchat-connect service install\` first`);
}

function requireServiceValue(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  if (/\0|\r|\n/u.test(value)) throw new Error(`${label} contains unsupported control characters`);
  return value;
}

function normalizeLogLines(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("log lines must be an integer between 1 and 10000");
  }
  return value;
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/%/gu, "%%").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}
