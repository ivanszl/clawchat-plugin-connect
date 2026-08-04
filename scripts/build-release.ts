import packageJson from "../package.json" with { type: "json" };

export interface ReleaseTarget {
  platform: "darwin" | "linux" | "windows";
  architecture: "arm64" | "x64";
  archiveName: string;
  archiveFormat: "tar.gz" | "zip";
  connectExecutable: "clawchat-connect" | "clawchat-connect.exe";
  livewareExecutable: "liveware" | "liveware.exe";
  livewareAsset: string;
}

export interface ReleasePayload {
  entries: readonly string[];
}

const releaseTargets: Record<string, ReleaseTarget> = {
  "darwin/arm64": {
    platform: "darwin",
    architecture: "arm64",
    archiveName: "clawchat-connect-darwin-arm64.tar.gz",
    archiveFormat: "tar.gz",
    connectExecutable: "clawchat-connect",
    livewareExecutable: "liveware",
    livewareAsset: "liveware-darwin-arm64",
  },
  "darwin/x64": {
    platform: "darwin",
    architecture: "x64",
    archiveName: "clawchat-connect-darwin-x64.tar.gz",
    archiveFormat: "tar.gz",
    connectExecutable: "clawchat-connect",
    livewareExecutable: "liveware",
    livewareAsset: "liveware-darwin-amd64",
  },
  "linux/arm64": {
    platform: "linux",
    architecture: "arm64",
    archiveName: "clawchat-connect-linux-arm64.tar.gz",
    archiveFormat: "tar.gz",
    connectExecutable: "clawchat-connect",
    livewareExecutable: "liveware",
    livewareAsset: "liveware-linux-arm64",
  },
  "linux/x64": {
    platform: "linux",
    architecture: "x64",
    archiveName: "clawchat-connect-linux-x64.tar.gz",
    archiveFormat: "tar.gz",
    connectExecutable: "clawchat-connect",
    livewareExecutable: "liveware",
    livewareAsset: "liveware-linux-amd64",
  },
  "win32/arm64": {
    platform: "windows",
    architecture: "arm64",
    archiveName: "clawchat-connect-windows-arm64.zip",
    archiveFormat: "zip",
    connectExecutable: "clawchat-connect.exe",
    livewareExecutable: "liveware.exe",
    livewareAsset: "liveware-windows-arm64.exe",
  },
  "win32/x64": {
    platform: "windows",
    architecture: "x64",
    archiveName: "clawchat-connect-windows-x64.zip",
    archiveFormat: "zip",
    connectExecutable: "clawchat-connect.exe",
    livewareExecutable: "liveware.exe",
    livewareAsset: "liveware-windows-amd64.exe",
  },
};

export function requireBetaVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version)) {
    throw new Error(`Expected a beta release version, received ${version}`);
  }
  return version;
}

export function resolveReleaseTarget(platform: NodeJS.Platform, architecture: string): ReleaseTarget {
  const target = releaseTargets[`${platform}/${architecture}`];
  if (!target) {
    throw new Error(`Unsupported release host: ${platform}/${architecture}`);
  }
  return target;
}

export function releasePayload(_target: ReleaseTarget): ReleasePayload {
  return {
    entries: [
      "clawchat-connect",
      "liveware",
      "clawchat-connect-client",
      "skills",
      "CHANGELOG.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ],
  };
}

if (import.meta.main) {
  requireBetaVersion(packageJson.version);
  resolveReleaseTarget(process.platform, process.arch);
}
