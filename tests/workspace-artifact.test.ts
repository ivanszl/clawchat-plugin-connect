import { describe, expect, it } from "bun:test";
import {
  classifyWorkspaceArtifact,
  normalizeWorkspaceArtifactHref,
  workspaceArtifactUrl,
} from "../src/workspace-artifact";

describe("Workspace Artifact", () => {
  it("classifies every supported renderer from a local path", () => {
    expect(classifyWorkspaceArtifact("/workspace/spec.md")).toMatchObject({
      kind: "markdown",
      mime: "text/plain; charset=utf-8",
      language: "markdown",
    });
    expect(classifyWorkspaceArtifact("/workspace/server.ts")).toMatchObject({
      kind: "code",
      mime: "text/plain; charset=utf-8",
      language: "typescript",
    });
    expect(classifyWorkspaceArtifact("/workspace/events.log")).toMatchObject({ kind: "text" });
    expect(classifyWorkspaceArtifact("/workspace/change.patch")).toMatchObject({
      kind: "diff",
      language: "diff",
    });
    expect(classifyWorkspaceArtifact("/workspace/mockup.webp")).toMatchObject({
      kind: "image",
      mime: "image/webp",
    });
    expect(classifyWorkspaceArtifact("/workspace/report.pdf")).toMatchObject({
      kind: "pdf",
      mime: "application/pdf",
    });
    expect(classifyWorkspaceArtifact("/workspace/data.tsv")).toMatchObject({
      kind: "table",
      mime: "text/tab-separated-values; charset=utf-8",
    });
    expect(classifyWorkspaceArtifact("/workspace/icon.svg")).toMatchObject({
      kind: "svg",
      mime: "image/svg+xml",
    });
    expect(classifyWorkspaceArtifact("/workspace/prototype.html")).toMatchObject({
      kind: "html",
      mime: "text/plain; charset=utf-8",
    });
  });

  it("rejects executable, secret, archive, and active MDX files", () => {
    expect(classifyWorkspaceArtifact("/workspace/.env")).toBeNull();
    expect(classifyWorkspaceArtifact("/workspace/skill.mdx")).toBeNull();
    expect(classifyWorkspaceArtifact("/workspace/tool.exe")).toBeNull();
    expect(classifyWorkspaceArtifact("/workspace/archive.zip")).toBeNull();
  });

  it("normalizes bracketed paths and source line suffixes", () => {
    expect(normalizeWorkspaceArtifactHref("</workspace/spec.md:37:4>")).toBe("/workspace/spec.md");
    expect(normalizeWorkspaceArtifactHref("/workspace/server.ts:12")).toBe("/workspace/server.ts");
    expect(normalizeWorkspaceArtifactHref("https://example.com/spec.md")).toBeNull();
  });

  it("creates a Session-scoped content URL", () => {
    expect(workspaceArtifactUrl("SL8JZA5F", "/workspace/mockup.png")).toBe(
      "/client/v1/sessions/SL8JZA5F/files?path=%2Fworkspace%2Fmockup.png",
    );
  });
});
