export const OFFICIAL_LIVEWARE_SOURCE_BASE_URL = "https://media.clawling.chat/liveware";

function binarySource(asset: string): { readonly asset: string; readonly url: string } {
  return {
    asset,
    url: `${OFFICIAL_LIVEWARE_SOURCE_BASE_URL}/${asset}`,
  };
}

// Connect uses Node target names; the media origin uses darwin, amd64, and Windows .exe asset names.
export const OFFICIAL_LIVEWARE_BINARY_SOURCES = {
  "darwin-arm64": binarySource("liveware-darwin-arm64"),
  "darwin-x64": binarySource("liveware-darwin-amd64"),
  "linux-arm64": binarySource("liveware-linux-arm64"),
  "linux-x64": binarySource("liveware-linux-amd64"),
  "win32-arm64": binarySource("liveware-windows-arm64.exe"),
  "win32-x64": binarySource("liveware-windows-amd64.exe"),
} as const;

export type OfficialLivewareBinaryTarget = keyof typeof OFFICIAL_LIVEWARE_BINARY_SOURCES;

export const OFFICIAL_LIVEWARE_VENDOR_SOURCES: Readonly<Record<OfficialLivewareBinaryTarget, string>> =
  Object.fromEntries(
    Object.entries(OFFICIAL_LIVEWARE_BINARY_SOURCES).map(([target, source]) => [
      target,
      `vendor/liveware/${source.asset}`,
    ]),
  ) as Record<OfficialLivewareBinaryTarget, string>;

export function officialLivewareBinarySource(target: string) {
  const source = OFFICIAL_LIVEWARE_BINARY_SOURCES[target as OfficialLivewareBinaryTarget];
  if (!source) throw new Error(`Official Liveware binary does not support target ${target}`);
  return source;
}
