import { join } from "node:path";

const connectOutput = join("dist", process.platform === "win32" ? "clawchat-connect.exe" : "clawchat-connect");

await run([process.execPath, "run", "build:web"]);
await run([
  process.execPath,
  "build",
  "./src/bin.ts",
  "--compile",
  "--minify",
  "--outfile",
  connectOutput,
]);
await run([process.execPath, "run", "build:official-plugins"]);

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[1] ?? command[0]} failed with exit code ${exitCode}`);
}
