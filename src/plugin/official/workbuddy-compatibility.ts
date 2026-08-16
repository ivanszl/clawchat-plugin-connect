import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectPluginRuntimeProbeContext, ConnectPluginRuntimeProbeResult } from "../sdk";
import { OFFICIAL_WORKBUDDY_DISTRIBUTIONS, type OfficialWorkBuddyDistribution } from "./workbuddy-manifest";

export type OfficialWorkBuddyInspection =
  | { readonly status: "missing"; readonly distribution: OfficialWorkBuddyDistribution }
  | {
      readonly status: "supported";
      readonly distribution: OfficialWorkBuddyDistribution;
      readonly bundleIdentifier: string;
      readonly applicationVersion: string;
      readonly embeddedCodeBuddyVersion: string;
    }
  | {
      readonly status: "unsupported";
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
  const supported = inspections.filter(
    (inspection): inspection is Extract<OfficialWorkBuddyInspection, { readonly status: "supported" }> =>
      inspection.status === "supported",
  );
  const detected = inspections.filter((inspection) => inspection.status !== "missing");
  const soleSupported = supported.length === 1 ? supported[0] : undefined;
  return {
    detected: detected.length > 0,
    compatible: supported.length > 0,
    ...(soleSupported ? { path: soleSupported.distribution.applicationPath } : {}),
    ...(supported.length > 0 ? { version: supported.map(observedVersionLabel).join("; ") } : {}),
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
    const executablePath = join(distribution.applicationPath, "Contents", "MacOS", "Electron");
    const [bundleIdentifier, applicationVersion] = await Promise.all([
      readPlistValue(plistPath, "CFBundleIdentifier"),
      readPlistValue(plistPath, "CFBundleShortVersionString"),
      access(executablePath, constants.X_OK),
    ]);
    const embeddedCodeBuddyVersion =
      bundleIdentifier === distribution.bundleIdentifier
        ? await readEmbeddedCodeBuddyVersion(distribution.applicationPath)
        : "[wrong-distribution]";
    if (bundleIdentifier !== distribution.bundleIdentifier) {
      return {
        status: "unsupported",
        distribution,
        bundleIdentifier,
        applicationVersion,
        embeddedCodeBuddyVersion,
      };
    }
    return {
      status: "supported",
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
  if (inspection.status === "missing") {
    return `${inspection.distribution.displayName} is missing from ${inspection.distribution.applicationPath}.`;
  }
  if ("error" in inspection) {
    return `${inspection.distribution.displayName} is installed at ${inspection.distribution.applicationPath} but its executable or diagnostic metadata is unreadable (${inspection.error}).`;
  }
  if (inspection.status === "supported") {
    return `Detected ${observedVersionLabel(inspection)} at ${inspection.distribution.applicationPath}; the executable is present, while ACP v${inspection.distribution.acpVersion}, endpoint ownership, Task identity, transcript identity, and required capabilities remain fail-closed and are verified during Binding activation.`;
  }
  return `Wrong distribution at ${inspection.distribution.applicationPath}: detected bundle ${inspection.bundleIdentifier}, application ${inspection.applicationVersion}, CodeBuddy ${inspection.embeddedCodeBuddyVersion}; expected bundle ${inspection.distribution.bundleIdentifier} for ${inspection.distribution.profile}.`;
}

function observedVersionLabel(
  inspection: Extract<OfficialWorkBuddyInspection, { readonly bundleIdentifier: string }>,
): string {
  return `${inspection.distribution.displayName} ${inspection.applicationVersion} + CodeBuddy ${inspection.embeddedCodeBuddyVersion}`;
}

async function readEmbeddedCodeBuddyVersion(applicationPath: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(applicationPath, "Contents", "Resources", "app.asar.unpacked", "cli", "package.json"), "utf8"),
  ) as { publishConfig?: { customPackage?: { version?: unknown } } };
  const version = manifest.publishConfig?.customPackage?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("embedded CodeBuddy manifest has no version");
  }
  return version.trim();
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
    const value = stdout.trim();
    if (!value) throw new Error(`WorkBuddy Info.plist ${key} is empty`);
    return value;
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
