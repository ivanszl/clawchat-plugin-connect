import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  type ConnectPluginBundleV1,
  type ConnectPluginManifestV1,
} from "../src/plugin/sdk";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const OFFICIAL_PLUGIN_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;

export type OfficialPluginTarget = (typeof OFFICIAL_PLUGIN_TARGETS)[number];

export interface OfficialPluginDescriptor {
  readonly supportedTargets?: readonly OfficialPluginTarget[];
  readonly manifest: Omit<ConnectPluginManifestV1, "artifacts" | "probe">;
  readonly entrypoint: string;
  readonly probeEntrypoint: string;
}

export interface BuildOfficialPluginOptions {
  readonly target?: string;
  readonly outputDirectory?: string;
  readonly write?: boolean;
}

export interface BuiltOfficialPlugin {
  readonly descriptor: OfficialPluginDescriptor;
  readonly target: string;
  readonly filename: string;
  readonly outputPath: string;
  readonly bundle: ConnectPluginBundleV1;
}

export function officialPluginSupportsTarget(descriptor: OfficialPluginDescriptor, target: string): boolean {
  const supportedTargets = descriptor.supportedTargets;
  if (supportedTargets === undefined) return true;
  if (!Array.isArray(supportedTargets) || supportedTargets.length === 0) {
    throw new Error(
      `Official Plugin descriptor ${descriptor.manifest.pluginId} supportedTargets must be a non-empty array`,
    );
  }
  const declaredTargets = new Set<string>();
  for (const candidate of supportedTargets as readonly unknown[]) {
    if (typeof candidate !== "string" || !OFFICIAL_PLUGIN_TARGETS.includes(candidate as OfficialPluginTarget)) {
      throw new Error(
        `Official Plugin descriptor ${descriptor.manifest.pluginId} declares unsupported target ${JSON.stringify(candidate)}`,
      );
    }
    if (declaredTargets.has(candidate)) {
      throw new Error(`Official Plugin descriptor ${descriptor.manifest.pluginId} declares duplicate target ${candidate}`);
    }
    declaredTargets.add(candidate);
  }
  return declaredTargets.has(target);
}

export async function buildOfficialPlugin(
  descriptor: OfficialPluginDescriptor,
  options: BuildOfficialPluginOptions = {},
): Promise<BuiltOfficialPlugin> {
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const entry = await bundleModule(descriptor.entrypoint);
  const probe = await bundleModule(descriptor.probeEntrypoint);
  const entryPath = `artifacts/${target}.mjs`;
  const probePath = "probe.mjs";
  const bundle: ConnectPluginBundleV1 = {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      ...structuredClone(descriptor.manifest),
      artifacts: [
        { target, entry: entryPath, integrity: `sha256-${createHash("sha256").update(entry).digest("base64")}` },
      ],
      probe: {
        entry: probePath,
        integrity: `sha256-${createHash("sha256").update(probe).digest("base64")}`,
      },
    },
    files: {
      [entryPath]: { encoding: "utf8", content: entry },
      [probePath]: { encoding: "utf8", content: probe },
    },
  };
  const filename = `${descriptor.manifest.pluginId.replace(/[^A-Za-z0-9._-]+/gu, "-")}-${descriptor.manifest.version.replace(/[^A-Za-z0-9._-]+/gu, "-")}-${target}.connect-plugin`;
  const outputDirectory = resolve(options.outputDirectory ?? join(repositoryRoot, "dist", "official-plugins"));
  const outputPath = join(outputDirectory, filename);
  if (options.write !== false) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  }
  return { descriptor, target, filename, outputPath, bundle };
}

export async function buildOfficialPlugins(
  descriptors: readonly OfficialPluginDescriptor[],
  options: BuildOfficialPluginOptions = {},
): Promise<BuiltOfficialPlugin[]> {
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const supported = descriptors.filter((descriptor) => officialPluginSupportsTarget(descriptor, target));
  return await Promise.all(
    supported.map(async (descriptor) => await buildOfficialPlugin(descriptor, { ...options, target })),
  );
}

export async function discoverOfficialPluginDescriptors(
  directory = join(repositoryRoot, "src", "plugin", "official"),
): Promise<OfficialPluginDescriptor[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith("-descriptor.ts")).sort();
  const descriptors: OfficialPluginDescriptor[] = [];
  for (const name of names) {
    // Descriptors are a runtime-discovered registry; their module specifiers are not known statically.
    const imported = (await import(`${pathToFileURL(join(directory, name)).href}?descriptor=${Date.now()}`)) as {
      default?: OfficialPluginDescriptor;
    };
    if (!imported.default) throw new Error(`Official Plugin descriptor ${name} must have a default export`);
    descriptors.push(imported.default);
  }
  return descriptors;
}

async function bundleModule(entrypoint: string): Promise<string> {
  const resolvedEntrypoint = resolve(repositoryRoot, entrypoint);
  const result = await Bun.build({
    entrypoints: [resolvedEntrypoint],
    target: "bun",
    format: "esm",
    packages: "bundle",
    splitting: false,
    sourcemap: "none",
    minify: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    const detail = result.logs.map((log) => log.message).join("; ") || `produced ${result.outputs.length} outputs`;
    throw new Error(`Failed to bundle ${entrypoint}: ${detail}`);
  }
  return await result.outputs[0]!.text();
}


if (import.meta.main) {
  const targetIndex = process.argv.indexOf("--target");
  const outputIndex = process.argv.indexOf("--output");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
  const outputDirectory = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (targetIndex >= 0 && !target) throw new Error("--target requires a value");
  if (outputIndex >= 0 && !outputDirectory) throw new Error("--output requires a value");
  const descriptors = await discoverOfficialPluginDescriptors();
  const built = await buildOfficialPlugins(descriptors, { target, outputDirectory });
  for (const plugin of built) console.log(plugin.outputPath);
}
