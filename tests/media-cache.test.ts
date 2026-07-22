import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cacheRuntimeMedia } from "../src/runtime/media-cache";

describe("Runtime media cache", () => {
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

    const first = await cacheRuntimeMedia(media, stateDbPath, { fetch: fetchMedia });
    const second = await cacheRuntimeMedia(media, stateDbPath, { fetch: fetchMedia });

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

    await expect(cacheRuntimeMedia(media, stateDbPath, { fetch: fetchMedia, maxBytes: 4 })).rejects.toThrow(
      /exceeds the 4-byte download limit/u,
    );
    expect(fetchMedia).not.toHaveBeenCalled();

    await expect(
      cacheRuntimeMedia({ ...media, size: undefined }, stateDbPath, { fetch: fetchMedia, maxBytes: 4 }),
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
      }),
    ).rejects.toThrow(/HTTP 403/u);
  });
});
