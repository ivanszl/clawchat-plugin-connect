#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import type { ConnectPluginAuthorManifestV1 } from "./builder";
import { writeConnectPluginBundle } from "./builder";

export interface ConnectPluginBuildCliDependencies {
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
}

const usage = `Usage:
  clawchat-connect-plugin build \\
    --manifest <manifest.json> \\
    --target <platform-arch> \\
    --artifact <prebuilt-entry.mjs> \\
    --artifact-entry <bundle/path.mjs> \\
    --output <plugin.connect-plugin> \\
    [--probe <prebuilt-probe.mjs> --probe-entry <bundle/path.mjs>]
`;

export async function runConnectPluginBuildCli(
  argv: readonly string[],
  dependencies: ConnectPluginBuildCliDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    writeStdout(usage);
    return 0;
  }

  try {
    if (argv[0] !== "build") throw new Error(`Unknown command: ${argv[0]}`);
    const options = parseOptions(argv.slice(1));
    const manifest = JSON.parse(await readFile(options.manifest, "utf8")) as ConnectPluginAuthorManifestV1;
    await writeConnectPluginBundle({
      manifest,
      target: options.target,
      artifactPath: options.artifact,
      artifactEntry: options.artifactEntry,
      outputPath: options.output,
      ...(options.probe ? { probePath: options.probe, probeEntry: options.probeEntry } : {}),
    });
    writeStdout(`${options.output}\n`);
    return 0;
  } catch (error) {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

interface ParsedOptions {
  manifest: string;
  target: string;
  artifact: string;
  artifactEntry: string;
  output: string;
  probe?: string;
  probeEntry?: string;
}

function parseOptions(argv: readonly string[]): ParsedOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Every build option requires an explicit value\n${usage}`);
    }
    if (knownOptions[option] !== true) throw new Error(`Unknown build option: ${option}`);
    if (values.has(option)) throw new Error(`Build option was provided more than once: ${option}`);
    values.set(option, value);
  }

  const parsed: ParsedOptions = {
    manifest: required(values, "--manifest"),
    target: required(values, "--target"),
    artifact: required(values, "--artifact"),
    artifactEntry: required(values, "--artifact-entry"),
    output: required(values, "--output"),
  };
  const probe = values.get("--probe");
  const probeEntry = values.get("--probe-entry");
  if (Boolean(probe) !== Boolean(probeEntry)) {
    throw new Error("--probe and --probe-entry must be provided together");
  }
  if (probe && probeEntry) {
    parsed.probe = probe;
    parsed.probeEntry = probeEntry;
  }
  return parsed;
}

const knownOptions: Readonly<Record<string, true>> = {
  "--manifest": true,
  "--target": true,
  "--artifact": true,
  "--artifact-entry": true,
  "--output": true,
  "--probe": true,
  "--probe-entry": true,
};

function required(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (!value) throw new Error(`Missing required build option: ${option}`);
  return value;
}

if (import.meta.main) {
  runConnectPluginBuildCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
