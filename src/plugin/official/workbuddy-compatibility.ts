import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectPluginRuntimeProbeContext, ConnectPluginRuntimeProbeResult } from "../sdk";
import { OFFICIAL_WORKBUDDY_DISTRIBUTIONS, type OfficialWorkBuddyDistribution } from "./workbuddy-manifest";

export type OfficialWorkBuddyInspection =
  | { readonly status: "missing"; readonly distribution: OfficialWorkBuddyDistribution }
  | {
      readonly status: "supported" | "unsupported";
      readonly distribution: OfficialWorkBuddyDistribution;
      readonly bundleIdentifier: string;
      readonly applicationVersion: string;
      readonly embeddedCodeBuddyVersion: string;
    }
  | {
      readonly status: "unsupported";
      readonly distribution: OfficialWorkBuddyDistribution;
      readonly error: string;
    };

export interface WorkBuddyProbeOptions {
  readonly inspect?: (distribution: OfficialWorkBuddyDistribution) => Promise<OfficialWorkBuddyInspection>;
}

export async function probeOfficialWorkBuddyRuntimes(
  context: ConnectPluginRuntimeProbeContext,
  options: WorkBuddyProbeOptions = {},
): Promise<ConnectPluginRuntimeProbeResult> {
  if (context.platform !== "darwin") {
    return {
      detected: false,
      compatible: false,
      detail: `The official WorkBuddy Runtime Plugin supports macOS only; current platform is ${context.platform}-${context.arch}.`,
    };
  }

  const inspect = options.inspect ?? inspectInstalledDistribution;
  const inspections = await Promise.all(OFFICIAL_WORKBUDDY_DISTRIBUTIONS.map(inspect));
  const supported = inspections.filter((inspection) => inspection.status === "supported");
  const detected = inspections.filter((inspection) => inspection.status !== "missing");
  return {
    detected: detected.length > 0,
    compatible: supported.length > 0,
    ...(supported.length === 1 ? { path: supported[0]!.distribution.applicationPath } : {}),
    ...(supported.length > 0
      ? { version: supported.map((inspection) => tupleLabel(inspection.distribution)).join("; ") }
      : {}),
    detail: inspections.map(inspectionDetail).join(" "),
  };
}

export async function inspectInstalledDistribution(
  distribution: OfficialWorkBuddyDistribution,
): Promise<OfficialWorkBuddyInspection> {
  try {
    await access(distribution.applicationPath);
  } catch (error) {
    if (isMissingPath(error)) return { status: "missing", distribution };
    return { status: "unsupported", distribution, error: errorMessage(error) };
  }

  try {
    const plistPath = join(distribution.applicationPath, "Contents", "Info.plist");
    const [bundleIdentifier, applicationVersion] = await Promise.all([
      readPlistValue(plistPath, "CFBundleIdentifier"),
      readPlistValue(plistPath, "CFBundleShortVersionString"),
    ]);
    const embeddedCodeBuddyVersion =
      bundleIdentifier === distribution.bundleIdentifier
        ? await readEmbeddedCodeBuddyVersion(distribution.applicationPath)
        : "[wrong-distribution]";
    const status =
      bundleIdentifier === distribution.bundleIdentifier &&
      applicationVersion === distribution.applicationVersion &&
      embeddedCodeBuddyVersion === distribution.embeddedCodeBuddyVersion
        ? "supported"
        : "unsupported";
    return {
      status,
      distribution,
      bundleIdentifier,
      applicationVersion,
      embeddedCodeBuddyVersion,
    };
  } catch (error) {
    return { status: "unsupported", distribution, error: errorMessage(error) };
  }
}

function inspectionDetail(inspection: OfficialWorkBuddyInspection): string {
  const supported = tupleLabel(inspection.distribution);
  if (inspection.status === "missing") {
    return `${supported} is missing from ${inspection.distribution.applicationPath}.`;
  }
  if ("error" in inspection) {
    return `${inspection.distribution.displayName} is installed at ${inspection.distribution.applicationPath} but its compatibility tuple is unreadable (${inspection.error}); supported tuple is ${supported}.`;
  }
  if (inspection.status === "supported") {
    return `Detected exact ${supported} at ${inspection.distribution.applicationPath}; ACP v1 remains fail-closed and is verified before Binding activation.`;
  }
  return `Unsupported ${inspection.distribution.profile} tuple at ${inspection.distribution.applicationPath}: detected bundle ${inspection.bundleIdentifier}, application ${inspection.applicationVersion}, CodeBuddy ${inspection.embeddedCodeBuddyVersion}; supported tuple is ${supported}.`;
}

function tupleLabel(distribution: OfficialWorkBuddyDistribution): string {
  return `${distribution.displayName} ${distribution.applicationVersion} + CodeBuddy ${distribution.embeddedCodeBuddyVersion} + ACP v${distribution.acpVersion}`;
}

async function readEmbeddedCodeBuddyVersion(applicationPath: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(applicationPath, "Contents", "Resources", "app.asar.unpacked", "cli", "package.json"), "utf8"),
  ) as { publishConfig?: { customPackage?: { version?: unknown } } };
  const version = manifest.publishConfig?.customPackage?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("embedded CodeBuddy manifest has no version");
  }
  return version;
}

async function readPlistValue(path: string, key: string): Promise<string> {
  const child = spawn("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = Promise.withResolvers<number | null>();
  child.once("error", exit.reject);
  child.once("exit", exit.resolve);
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    exit.reject(new Error("WorkBuddy Info.plist inspection timed out"));
  }, 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      exit.promise,
      readStream(child.stdout),
      readStream(child.stderr),
    ]);
    if (code !== 0) throw new Error(stderr.trim() || `plutil exited with status ${String(code)}`);
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream) output += String(chunk);
  return output;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
