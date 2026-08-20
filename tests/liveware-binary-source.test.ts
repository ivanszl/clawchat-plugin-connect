import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncLivewareBinaries } from "../scripts/sync-liveware-binaries";
import {
  OFFICIAL_LIVEWARE_BINARY_SOURCES,
  officialLivewareBinarySource,
} from "../src/plugin/official/liveware-binaries";

const expectedSources = {
  "darwin-arm64": {
    asset: "liveware-darwin-arm64",
    url: "https://media.clawling.chat/liveware/liveware-darwin-arm64",
  },
  "darwin-x64": {
    asset: "liveware-darwin-amd64",
    url: "https://media.clawling.chat/liveware/liveware-darwin-amd64",
  },
  "linux-arm64": {
    asset: "liveware-linux-arm64",
    url: "https://media.clawling.chat/liveware/liveware-linux-arm64",
  },
  "linux-x64": {
    asset: "liveware-linux-amd64",
    url: "https://media.clawling.chat/liveware/liveware-linux-amd64",
  },
  "win32-arm64": {
    asset: "liveware-windows-arm64.exe",
    url: "https://media.clawling.chat/liveware/liveware-windows-arm64.exe",
  },
  "win32-x64": {
    asset: "liveware-windows-amd64.exe",
    url: "https://media.clawling.chat/liveware/liveware-windows-amd64.exe",
  },
} as const;

describe("official Liveware binary source", () => {
  it("maps every supported Connect target to the sole media.clawling.chat source", () => {
    expect(OFFICIAL_LIVEWARE_BINARY_SOURCES).toEqual(expectedSources);
    for (const [target, expected] of Object.entries(expectedSources)) {
      expect(officialLivewareBinarySource(target)).toEqual(expected);
    }
    expect(() => officialLivewareBinarySource("freebsd-x64")).toThrow(
      "Official Liveware binary does not support target freebsd-x64",
    );
  });

  it("syncs selected binaries and pins their downloaded bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-binary-source-"));
    const bytes = new TextEncoder().encode("authoritative liveware binary");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const requests: string[] = [];

    try {
      const result = await syncLivewareBinaries({
        bundleDirectory: directory,
        targets: ["darwin-arm64"],
        fetch: async (input) => {
          requests.push(String(input));
          return new Response(bytes, { status: 200 });
        },
      });

      expect(requests).toEqual([expectedSources["darwin-arm64"].url]);
      expect(result).toEqual([
        {
          target: "darwin-arm64",
          asset: "liveware-darwin-arm64",
          checksum,
        },
      ]);
      expect(await readFile(join(directory, "liveware-darwin-arm64"))).toEqual(Buffer.from(bytes));
      expect(await readFile(join(directory, "SHA256SUMS"), "utf8")).toBe(`${checksum}  liveware-darwin-arm64\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not replace pinned bytes when the authoritative download fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-binary-source-failure-"));
    const asset = "liveware-linux-amd64";
    const original = "pinned binary";
    const manifest = `${createHash("sha256").update(original).digest("hex")}  ${asset}\n`;

    try {
      await writeFile(join(directory, asset), original);
      await writeFile(join(directory, "SHA256SUMS"), manifest);

      await expect(
        syncLivewareBinaries({
          bundleDirectory: directory,
          targets: ["linux-x64"],
          fetch: async () => new Response("missing", { status: 404 }),
        }),
      ).rejects.toThrow("Failed to download official Liveware binary for linux-x64: HTTP 404");

      expect(await readFile(join(directory, asset), "utf8")).toBe(original);
      expect(await readFile(join(directory, "SHA256SUMS"), "utf8")).toBe(manifest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
