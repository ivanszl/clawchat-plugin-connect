import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackgroundCommandResult,
  currentConnectCommand,
  manageBackgroundService,
} from "../src/background-service";

function successfulCommand(stdout = ""): BackgroundCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("background service manager", () => {
  it("installs one macOS LaunchAgent that starts the complete Connect Service", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "clawchat-connect-launchd-"));
    const commands: string[][] = [];
    const runCommand = mock(async (command: string[]) => {
      commands.push(command);
      return command[1] === "bootout"
        ? { exitCode: 3, stdout: "", stderr: "Boot-out failed: No such process" }
        : successfulCommand();
    });
    const configPath = join(homeDirectory, "connect config.json");

    const result = await manageBackgroundService(
      { action: "install", configPath, command: ["/Applications/Claw & Chat/clawchat-connect"] },
      { platform: "darwin", homeDirectory, uid: 501, pathEnvironment: "/opt/codex/bin:/usr/bin", runCommand },
    );

    expect(result).toMatchObject({ running: true, message: expect.stringContaining("launchd") });
    const plistPath = join(homeDirectory, "Library", "LaunchAgents", "com.clawchat.connect.plist");
    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain("/Applications/Claw &amp; Chat/clawchat-connect");
    expect(plist).toContain(`<string>${configPath}</string>`);
    expect(plist).toContain("<string>run</string>");
    expect(plist).not.toContain("--agent");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(commands.map((command) => command.slice(0, 3))).toEqual([
      ["launchctl", "bootout", "gui/501/com.clawchat.connect"],
      ["launchctl", "enable", "gui/501/com.clawchat.connect"],
      ["launchctl", "bootstrap", "gui/501"],
    ]);
  });

  it("manages the single LaunchAgent lifecycle and reports status", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "clawchat-connect-launchd-lifecycle-"));
    const commands: string[][] = [];
    const runCommand = mock(async (command: string[]) => {
      commands.push(command);
      if (command[1] === "print") return successfulCommand("state = running\n");
      return successfulCommand();
    });
    const base = { configPath: join(homeDirectory, "config.json"), command: ["/usr/local/bin/clawchat-connect"] };
    const dependencies = { platform: "darwin" as const, homeDirectory, uid: 502, runCommand };

    await manageBackgroundService({ action: "install", ...base }, dependencies);
    await expect(manageBackgroundService({ action: "status", ...base }, dependencies)).resolves.toMatchObject({
      running: true,
      message: expect.stringContaining("state: running"),
    });
    await expect(manageBackgroundService({ action: "restart", ...base }, dependencies)).resolves.toMatchObject({
      running: true,
    });
    await expect(manageBackgroundService({ action: "stop", ...base }, dependencies)).resolves.toMatchObject({
      running: false,
    });
    expect(commands.some((command) => command[1] === "kickstart" && command.includes("-k"))).toBe(true);
  });

  it("installs one systemd user unit and delegates lifecycle and logs", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "clawchat-connect-systemd-"));
    const commands: Array<{ command: string[]; inheritOutput: boolean | undefined }> = [];
    const runCommand = mock(async (command: string[], inheritOutput?: boolean) => {
      commands.push({ command, inheritOutput });
      if (command[2] === "is-active") return successfulCommand("active\n");
      if (command[0] === "journalctl") return successfulCommand("connected\n");
      return successfulCommand();
    });
    const configPath = join(homeDirectory, "connect config.json");
    const base = { configPath, command: ["/opt/Claw Chat/clawchat-connect"] };
    const dependencies = {
      platform: "linux" as const,
      homeDirectory,
      pathEnvironment: "/opt/codex/bin:/usr/bin",
      runCommand,
    };

    const installed = await manageBackgroundService({ action: "install", ...base }, dependencies);
    expect(installed).toMatchObject({ running: true, message: expect.stringContaining("systemd") });
    const unit = await readFile(join(homeDirectory, ".config", "systemd", "user", "clawchat-connect.service"), "utf8");
    expect(unit).toContain(`ExecStart="/opt/Claw Chat/clawchat-connect" "run" "--config" "${configPath}"`);
    expect(unit).not.toContain("--agent");
    expect(unit).toContain('Environment="PATH=/opt/codex/bin:/usr/bin"');
    expect(unit).toContain("Restart=on-failure");
    expect(commands.some(({ command }) => command.includes("enable") && command.includes("--now"))).toBe(true);

    await expect(manageBackgroundService({ action: "status", ...base }, dependencies)).resolves.toMatchObject({
      running: true,
    });
    await expect(
      manageBackgroundService({ action: "logs", lines: 25, follow: true, ...base }, dependencies),
    ).resolves.toMatchObject({ message: "Log stream ended.\n" });
    expect(commands.at(-1)).toEqual({
      command: ["journalctl", "--user", "--unit", "clawchat-connect.service", "--lines", "25", "--follow"],
      inheritOutput: true,
    });
  });

  it("rejects unsupported platforms and unsafe service values", async () => {
    await expect(
      manageBackgroundService(
        { action: "install", configPath: "/tmp/config.json", command: ["/bin/connect"] },
        { platform: "win32" },
      ),
    ).rejects.toThrow("not supported");
    await expect(
      manageBackgroundService(
        { action: "install", configPath: "/tmp/bad\nconfig.json", command: ["/bin/connect"] },
        { platform: "linux", runCommand: async () => successfulCommand() },
      ),
    ).rejects.toThrow("control characters");
  });

  it("resolves a command that can relaunch the current Connect entrypoint", () => {
    const command = currentConnectCommand();
    expect(command[0]).toBeTruthy();
    expect(command.length).toBeGreaterThanOrEqual(1);
    expect(command.length).toBeLessThanOrEqual(2);
  });
});
