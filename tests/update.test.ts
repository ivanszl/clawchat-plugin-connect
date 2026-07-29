import { describe, expect, it, mock } from "bun:test";
import { updateConnect } from "../src/update";

describe("Connect update", () => {
  it("runs the official installer in the current installation directory and refreshes the service", async () => {
    const commands: Array<{ command: string[]; environment?: NodeJS.ProcessEnv }> = [];
    const runCommand = mock(async (command: string[], environment?: NodeJS.ProcessEnv) => {
      commands.push({ command, environment });
    });
    const fetchInstaller = mock(async () => new Response("#!/bin/sh\n", { status: 200 }));

    const result = await updateConnect({
      version: "0.1.0-alpha.16",
      configPath: "/tmp/connect.json",
      executablePath: "/opt/connect/clawchat-connect",
      platform: "darwin",
      environment: { PATH: "/usr/bin:/bin" },
      fetch: fetchInstaller as unknown as typeof globalThis.fetch,
      runCommand,
    });

    expect(fetchInstaller).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/clawling/clawchat-plugin-connect/main/install.sh",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]?.command[0]).toBe("sh");
    expect(commands[0]?.command.at(-1)).toBe("v0.1.0-alpha.16");
    expect(commands[0]?.environment?.CLAWCHAT_CONNECT_INSTALL_DIR).toBe("/opt/connect");
    expect(commands[1]?.command).toEqual([
      "/opt/connect/clawchat-connect",
      "service",
      "install",
      "--config",
      "/tmp/connect.json",
    ]);
    expect(result).toEqual({
      version: "v0.1.0-alpha.16",
      executablePath: "/opt/connect/clawchat-connect",
    });
  });

  it("rejects an invalid release version before downloading anything", async () => {
    const fetchInstaller = mock(async () => new Response(""));

    await expect(
      updateConnect({
        version: "latest please",
        fetch: fetchInstaller as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("Invalid Connect release version");
    expect(fetchInstaller).not.toHaveBeenCalled();
  });
});
