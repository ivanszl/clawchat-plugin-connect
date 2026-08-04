import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptBlock } from "../src/client-contract";
// @ts-expect-error The service tsconfig intentionally has no JSX; Bun loads this Web component for the cross-seam regression.
import { TranscriptBlockView } from "../web/src/features/transcript/TranscriptBlockView";
// @ts-expect-error The service tsconfig intentionally has no JSX; Bun loads the production locale provider for this seam.
import { ClientInternationalizationProvider } from "../web/src/i18n/client-i18n";
import type { ClientLocale } from "../web/src/i18n/client-locale";

it("does not render a standalone Runtime Markdown image before Connect materializes it", () => {
  const block: TranscriptBlock = {
    id: "assistant-local-image",
    revision: 1,
    sequence: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    type: "message",
    origin: "runtime",
    state: "complete",
    plainText: "![橘猫宇航员](/Users/example/orange-cat-astronaut.png)",
    role: "assistant",
    author: "Agent",
    markdown: "![橘猫宇航员](/Users/example/orange-cat-astronaut.png)",
  };

  const html = renderTranscript(block, "zh-Hans");

  expect(html).not.toContain("<img");
  expect(html).not.toContain("/Users/example/orange-cat-astronaut.png");
  expect(html).toContain("图片已阻止：橘猫宇航员");
});

it("leaves image-like text inside a fenced code block as code", () => {
  const block: TranscriptBlock = {
    id: "assistant-image-code",
    revision: 1,
    sequence: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    type: "message",
    origin: "runtime",
    state: "complete",
    plainText: "```md\n![example](/Users/example/image.png)\n```",
    role: "assistant",
    author: "Agent",
    markdown: "```md\n![example](/Users/example/image.png)\n```",
  };

  const html = renderTranscript(block, "zh-Hans");

  expect(html).not.toContain("<img");
  expect(html).toContain("/Users/example/image.png");
  expect(html).not.toContain("图片已阻止");
});

it("routes an absolute Markdown file link through the Session-scoped workspace file endpoint", () => {
  const block: TranscriptBlock = {
    id: "assistant-local-spec",
    revision: 1,
    sequence: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    type: "message",
    origin: "runtime",
    state: "complete",
    plainText: "OpenCode Runtime Adapter spec",
    role: "assistant",
    author: "Agent",
    markdown:
      "[OpenCode Runtime Adapter spec](/Volumes/SAMSUNG/Projects/clawchat-plugin-connect/.scratch/opencode-runtime-adapter/spec.md)",
  };

  const html = renderTranscript(block, "zh-Hans");

  expect(html).toContain(
    'href="/client/v1/sessions/SL8JZA5F/files?path=%2FVolumes%2FSAMSUNG%2FProjects%2Fclawchat-plugin-connect%2F.scratch%2Fopencode-runtime-adapter%2Fspec.md"',
  );
  expect(html).not.toContain('target="_blank"');
  expect(html).not.toContain('href="/Volumes/');
});

it("normalizes a bracketed local document link with a line suffix", () => {
  const block: TranscriptBlock = {
    id: "assistant-local-spec-line",
    revision: 1,
    sequence: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    type: "message",
    origin: "runtime",
    state: "complete",
    plainText: "Spec implementation decisions",
    role: "assistant",
    author: "Agent",
    markdown:
      "[Spec implementation decisions](</Volumes/SAMSUNG/Projects/clawchat-plugin-connect/.scratch/example/spec.md:37>)",
  };

  const html = renderTranscript(block, "zh-Hans");

  expect(html).toContain(
    'href="/client/v1/sessions/SL8JZA5F/files?path=%2FVolumes%2FSAMSUNG%2FProjects%2Fclawchat-plugin-connect%2F.scratch%2Fexample%2Fspec.md"',
  );
});

it("routes supported local artifacts through the same Session-scoped seam", () => {
  const block: TranscriptBlock = {
    id: "assistant-local-artifacts",
    revision: 1,
    sequence: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    type: "message",
    origin: "runtime",
    state: "complete",
    plainText: "Artifacts",
    role: "assistant",
    author: "Agent",
    markdown: "[Image](/workspace/mockup.png) [Code](/workspace/server.ts:12) [PDF](/workspace/report.pdf)",
  };

  const html = renderTranscript(block, "zh-Hans");

  expect(html).toContain("path=%2Fworkspace%2Fmockup.png");
  expect(html).toContain("path=%2Fworkspace%2Fserver.ts");
  expect(html).toContain("path=%2Fworkspace%2Freport.pdf");
  expect(html).not.toContain('target="_blank"');
});

it("localizes Connect-owned Transcript chrome without changing Runtime-authored content", () => {
  const block: TranscriptBlock = {
    id: "subagent-runtime-content",
    revision: 1,
    sequence: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    type: "subagent",
    origin: "runtime",
    state: "complete",
    plainText: "Runtime-owned title",
    title: "Runtime-owned title",
    role: null,
    activityKind: "started",
    blocks: [],
  };

  const html = renderTranscript(block, "en");

  expect(html).toContain("Subagent · Runtime-owned title · 0 items");
  expect(html).toContain("Started by primary Agent");
  expect(html).toContain("This subagent has no displayable history.");
  expect(html).not.toContain("子 Agent");
});

function renderTranscript(block: TranscriptBlock, locale: ClientLocale): string {
  return renderToStaticMarkup(
    createElement(
      ClientInternationalizationProvider,
      { locale },
      createElement(TranscriptBlockView, { block, sessionRef: "SL8JZA5F" }),
    ),
  );
}
