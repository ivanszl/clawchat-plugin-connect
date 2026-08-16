import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONNECT_PLUGIN_BUNDLE_FORMAT, type ConnectPluginBundleV1, type ConnectPluginManifestV1 } from "./sdk";
import { connectPluginBundleFileBytes, parseConnectPluginBundle, verifyConnectPluginIntegrity } from "./store";

/** The author-owned portion of a Plugin manifest. Artifact metadata is generated from the exact entry file. */
export type ConnectPluginAuthorManifestV1 = Omit<ConnectPluginManifestV1, "artifacts">;

export interface BuildConnectPluginBundleOptions {
  readonly manifest: ConnectPluginAuthorManifestV1;
  readonly target: string;
  readonly artifactPath: string;
  readonly artifactEntry: string;
  readonly browserArtifactPaths?: Readonly<Record<string, string>>;
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
  if (Object.hasOwn(options.manifest, "artifacts")) {
    throw new Error("Author manifest must omit generated artifact fields");
  }

  const artifactBytes = await readFile(options.artifactPath);
  const files: ConnectPluginBundleV1["files"] = {
    [options.artifactEntry]: { encoding: "base64", content: artifactBytes.toString("base64") },
  };
  const artifactIntegrity = sha256Integrity(artifactBytes);
  for (const capability of options.manifest.capabilities) {
    if (capability.type !== "client-extension") continue;
    for (const artifact of [
      { entry: capability.browser.entry, integrity: capability.browser.integrity },
      ...capability.browser.styles,
    ]) {
      const artifactPath = options.browserArtifactPaths?.[artifact.entry];
      if (!artifactPath) {
        throw new Error(`Client Extension artifact ${artifact.entry} has no browserArtifactPaths entry`);
      }
      const bytes = await readFile(artifactPath);
      verifyConnectPluginIntegrity(bytes, artifact.integrity, `${options.manifest.pluginId} ${artifact.entry}`);
      const encoded = { encoding: "base64" as const, content: bytes.toString("base64") };
      const existing = files[artifact.entry];
      if (existing && existing.content !== encoded.content) {
        throw new Error(`Plugin Bundle artifact path ${artifact.entry} has conflicting content`);
      }
      files[artifact.entry] = encoded;
    }
  }

  const candidate: ConnectPluginBundleV1 = {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      ...options.manifest,
      artifacts: [{ target: options.target, entry: options.artifactEntry, integrity: artifactIntegrity }],
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
  return bundle as ConnectPluginBundleV1;
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
