import { describe, expect, test } from "bun:test";
import { releasePayload, requireBetaVersion, resolveReleaseTarget } from "../scripts/build-release";

describe("requireBetaVersion", () => {
  test.each(["0.1.0-beta.1", "12.34.56-beta.9"])("accepts %s", (version) => {
    expect(requireBetaVersion(version)).toBe(version);
  });

  test.each(["0.1.0-alpha.33", "0.1.0-beta.0", "0.1.0-beta.-1", "0.1.0-beta.01", "v0.1.0-beta.1", "0.1.0"])(
    "rejects %s",
    (version) => {
      expect(() => requireBetaVersion(version)).toThrow("beta release version");
    },
  );
});

describe("resolveReleaseTarget", () => {
  test("maps Apple silicon", () => {
    expect(resolveReleaseTarget("darwin", "arm64")).toMatchObject({
      platform: "darwin",
      architecture: "arm64",
      archiveName: "clawchat-connect-darwin-arm64.tar.gz",
      connectExecutable: "clawchat-connect",
      livewareAsset: "liveware-darwin-arm64",
    });
  });

  test("maps Linux x64 to the amd64 Liveware asset", () => {
    expect(resolveReleaseTarget("linux", "x64")).toMatchObject({
      platform: "linux",
      architecture: "x64",
      archiveName: "clawchat-connect-linux-x64.tar.gz",
      livewareAsset: "liveware-linux-amd64",
    });
  });

  test("maps Windows x64 to a zip", () => {
    expect(resolveReleaseTarget("win32", "x64")).toMatchObject({
      platform: "windows",
      architecture: "x64",
      archiveName: "clawchat-connect-windows-x64.zip",
      connectExecutable: "clawchat-connect.exe",
      livewareExecutable: "liveware.exe",
    });
  });

  test("rejects unsupported hosts", () => {
    expect(() => resolveReleaseTarget("freebsd", "x64")).toThrow("Unsupported release host");
  });
});

test("release payload is complete", () => {
  const target = resolveReleaseTarget("darwin", "arm64");
  expect(releasePayload(target).entries).toEqual([
    "clawchat-connect",
    "liveware",
    "clawchat-connect-client",
    "skills",
    "CHANGELOG.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]);
});
