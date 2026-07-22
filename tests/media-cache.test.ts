import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, readdir, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cacheRuntimeMedia } from "../src/runtime/media-cache";

describe("Runtime media cache", () => {
  const trustedMediaOrigin = { trustedOrigins: ["https://media.example"] } as const;

  it("downloads an opaque media URL once and reuses the cached file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-media-cache-"));
    const stateDbPath = join(directory, "state.sqlite");
    const fetchMedia = mock(
      async (_input: RequestInfo | URL) => new Response("pdf-body", { headers: { "content-length": "8" } }),
    );
    const media = {
      kind: "file" as const,
      url: "https://media.example/report.pdf?signature=opaque&part=1",
      name: "../unsafe/report.pdf",
      mime: "application/pdf",
      size: 8,
    };

    const first = await cacheRuntimeMedia(media, stateDbPath, { fetch: fetchMedia, ...trustedMediaOrigin });
    const second = await cacheRuntimeMedia(media, stateDbPath, { fetch: fetchMedia, ...trustedMediaOrigin });

    expect(first).toBe(second);
    expect(basename(first)).toBe("report.pdf");
    expect(await readFile(first, "utf8")).toBe("pdf-body");
    expect(fetchMedia).toHaveBeenCalledTimes(1);
    expect(String(fetchMedia.mock.calls[0]?.[0])).toBe(media.url);
  });

  it("rejects declared and streamed bodies above the limit without leaving a partial file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-media-limit-"));
    const stateDbPath = join(directory, "state.sqlite");
    const media = {
      kind: "video" as const,
      url: "https://media.example/demo.mp4",
      name: "demo.mp4",
      size: 5,
    };
    const fetchMedia = mock(async (_input: RequestInfo | URL) => new Response("12345"));

    await expect(
      cacheRuntimeMedia(media, stateDbPath, { fetch: fetchMedia, maxBytes: 4, ...trustedMediaOrigin }),
    ).rejects.toThrow(/exceeds the 4-byte download limit/u);
    expect(fetchMedia).not.toHaveBeenCalled();

    await expect(
      cacheRuntimeMedia({ ...media, size: undefined }, stateDbPath, {
        fetch: fetchMedia,
        maxBytes: 4,
        ...trustedMediaOrigin,
      }),
    ).rejects.toThrow(/exceeds the 4-byte download limit/u);
    const cacheRoot = join(directory, "media-cache");
    const cacheDirectories = await readdir(cacheRoot);
    expect(cacheDirectories).toHaveLength(1);
    expect(await readdir(join(cacheRoot, cacheDirectories[0] || "missing"))).toEqual([]);
  });

  it("rejects non-HTTP media URLs and failed responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-media-errors-"));
    const stateDbPath = join(directory, "state.sqlite");
    const fetchMedia = mock(async (_input: RequestInfo | URL) => new Response("forbidden", { status: 403 }));

    await expect(
      cacheRuntimeMedia({ kind: "file", url: "file:///etc/passwd", name: "passwd" }, stateDbPath, {
        fetch: fetchMedia,
      }),
    ).rejects.toThrow(/protocol is unsupported/u);
    expect(fetchMedia).not.toHaveBeenCalled();
    await expect(
      cacheRuntimeMedia({ kind: "file", url: "https://media.example/private" }, stateDbPath, {
        fetch: fetchMedia,
        ...trustedMediaOrigin,
      }),
    ).rejects.toThrow(/HTTP 403/u);
  });

  it("rejects private network targets and revalidates redirect destinations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-media-ssrf-"));
    const stateDbPath = join(directory, "state.sqlite");
    const fetchMedia = mock(async () => new Response("private"));

    await expect(
      cacheRuntimeMedia({ kind: "image", url: "http://127.0.0.1/admin" }, stateDbPath, { fetch: fetchMedia }),
    ).rejects.toThrow(/private or local address/u);
    expect(fetchMedia).not.toHaveBeenCalled();

    await expect(
      cacheRuntimeMedia({ kind: "image", url: "https://internal.example/admin" }, stateDbPath, {
        fetch: fetchMedia,
        resolveHostname: async () => ["10.0.0.8"],
      }),
    ).rejects.toThrow(/private or local address/u);
    expect(fetchMedia).not.toHaveBeenCalled();

    const redirectingFetch = mock(
      async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    );
    await expect(
      cacheRuntimeMedia({ kind: "image", url: "https://media.example/photo.png" }, stateDbPath, {
        fetch: redirectingFetch,
        ...trustedMediaOrigin,
      }),
    ).rejects.toThrow(/private or local address/u);
    expect(redirectingFetch).toHaveBeenCalledTimes(1);
  });

  it("revalidates the source URL before reusing a cached media file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-media-cache-policy-"));
    const stateDbPath = join(directory, "state.sqlite");
    const media = { kind: "image" as const, url: "http://127.0.0.1/private.png", name: "private.png" };
    const fetchMedia = mock(async () => new Response("cached"));

    await cacheRuntimeMedia(media, stateDbPath, {
      fetch: fetchMedia,
      trustedOrigins: ["http://127.0.0.1"],
    });
    await expect(cacheRuntimeMedia(media, stateDbPath, { fetch: fetchMedia })).rejects.toThrow(
      /private or local address/u,
    );
    expect(fetchMedia).toHaveBeenCalledTimes(1);
  });

  it("bounds total cache size by evicting the least recently used file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-media-capacity-"));
    const stateDbPath = join(directory, "state.sqlite");
    let now = 10_000;
    const fetchMedia = mock(
      async (input: RequestInfo | URL) => new Response(String(input).includes("first") ? "11111" : "22222"),
    );
    const cache = async (url: string, name: string) =>
      await cacheRuntimeMedia({ kind: "file", url, name }, stateDbPath, {
        fetch: fetchMedia,
        maxTotalBytes: 8,
        now: () => now,
        ...trustedMediaOrigin,
      });

    const first = await cache("https://media.example/first", "first.bin");
    await utimes(first, new Date(now), new Date(now));
    now += 1_000;
    const second = await cache("https://media.example/second", "second.bin");

    await expect(stat(first)).rejects.toThrow();
    expect(await readFile(second, "utf8")).toBe("22222");
  });

  it("expires cached media after its TTL and downloads it again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-media-ttl-"));
    const stateDbPath = join(directory, "state.sqlite");
    let now = 20_000;
    const fetchMedia = mock(async () => new Response("fresh"));
    const media = { kind: "file" as const, url: "https://media.example/expiring", name: "expiring.bin" };
    const options = { fetch: fetchMedia, ttlMs: 1_000, now: () => now, ...trustedMediaOrigin };

    const first = await cacheRuntimeMedia(media, stateDbPath, options);
    await utimes(first, new Date(now), new Date(now));
    now += 999;
    await cacheRuntimeMedia(media, stateDbPath, options);
    now += 1_001;
    await cacheRuntimeMedia(media, stateDbPath, options);

    expect(fetchMedia).toHaveBeenCalledTimes(2);
  });
});
