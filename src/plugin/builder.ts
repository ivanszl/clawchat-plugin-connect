import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONNECT_PLUGIN_BUNDLE_FORMAT, type ConnectPluginBundleV1, type ConnectPluginManifestV1 } from "./sdk";
import { connectPluginBundleFileBytes, parseConnectPluginBundle, verifyConnectPluginIntegrity } from "./store";

/**
 * The author-owned portion of a Plugin manifest. Artifact and probe metadata is
 * generated from the exact files placed in the Bundle.
 */
export type ConnectPluginAuthorManifestV1 = Omit<ConnectPluginManifestV1, "artifacts" | "probe">;

export interface BuildConnectPluginBundleOptions {
  readonly manifest: ConnectPluginAuthorManifestV1;
  readonly target: string;
  readonly artifactPath: string;
  readonly artifactEntry: string;
  readonly probePath?: string;
  readonly probeEntry?: string;
}

export interface WriteConnectPluginBundleOptions extends BuildConnectPluginBundleOptions {
  readonly outputPath: string;
}

/**
 * Builds one target-specific, self-contained Plugin Bundle from prebuilt ESM.
 * The returned value has passed the production Bundle parser and integrity
 * verification used by installation.
 */
export async function buildConnectPluginBundle(
  options: BuildConnectPluginBundleOptions,
): Promise<ConnectPluginBundleV1> {
  if (Object.hasOwn(options.manifest, "artifacts") || Object.hasOwn(options.manifest, "probe")) {
    throw new Error("Author manifest must omit generated artifacts and probe fields");
  }
  if (Boolean(options.probePath) !== Boolean(options.probeEntry)) {
    throw new Error("Plugin probePath and probeEntry must be provided together");
  }

  const artifactBytes = await readFile(options.artifactPath);
  const files: ConnectPluginBundleV1["files"] = {
    [options.artifactEntry]: { encoding: "base64", content: artifactBytes.toString("base64") },
  };
  const artifactIntegrity = sha256Integrity(artifactBytes);

  let probe: ConnectPluginManifestV1["probe"];
  if (options.probePath && options.probeEntry) {
    if (options.probeEntry === options.artifactEntry) {
      throw new Error("Plugin artifactEntry and probeEntry must be different Bundle paths");
    }
    const probeBytes = await readFile(options.probePath);
    files[options.probeEntry] = { encoding: "base64", content: probeBytes.toString("base64") };
    probe = { entry: options.probeEntry, integrity: sha256Integrity(probeBytes) };
  }

  const candidate: ConnectPluginBundleV1 = {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      ...options.manifest,
      artifacts: [{ target: options.target, entry: options.artifactEntry, integrity: artifactIntegrity }],
      ...(probe ? { probe } : {}),
    },
    files,
  };
  const bundle = parseConnectPluginBundle(JSON.stringify(candidate), "generated author Bundle");
  for (const artifact of bundle.manifest.artifacts) {
    verifyConnectPluginIntegrity(
      connectPluginBundleFileBytes(bundle, artifact.entry),
      artifact.integrity,
      `${bundle.manifest.pluginId} ${artifact.entry}`,
    );
  }
  if (bundle.manifest.probe) {
    verifyConnectPluginIntegrity(
      connectPluginBundleFileBytes(bundle, bundle.manifest.probe.entry),
      bundle.manifest.probe.integrity,
      `${bundle.manifest.pluginId} runtime probe`,
    );
  }
  return bundle;
}

/** Writes a deterministic JSON representation of a validated Plugin Bundle. */
export async function writeConnectPluginBundle(
  options: WriteConnectPluginBundleOptions,
): Promise<ConnectPluginBundleV1> {
  const bundle = await buildConnectPluginBundle(options);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function sha256Integrity(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}
