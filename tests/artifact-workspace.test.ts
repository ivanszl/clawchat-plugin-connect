import { describe, expect, it } from "bun:test";
import {
  activateArtifact,
  closeArtifact,
  createArtifactWorkspaceState,
  openArtifact,
  parseDelimitedText,
  showConversation,
} from "../web/src/features/artifacts/artifact-workspace";

describe("Artifact Workspace", () => {
  it("opens, de-duplicates, activates, and closes Artifact tabs", () => {
    const empty = createArtifactWorkspaceState();
    expect(empty.activeId).toBeNull();
    const specOpen = openArtifact(empty, "SL8JZA5F", "/workspace/spec.md");
    const imageOpen = openArtifact(specOpen, "SL8JZA5F", "/workspace/mockup.png");
    const specReopened = openArtifact(imageOpen, "SL8JZA5F", "/workspace/spec.md");

    expect(specReopened.tabs).toHaveLength(2);
    expect(specReopened.activeId).toBe("/workspace/spec.md");
    expect(specReopened.tabs[0]).toMatchObject({ title: "spec.md", kind: "markdown" });

    const closed = closeArtifact(specReopened, "/workspace/spec.md");
    expect(closed.tabs.map((tab) => tab.path)).toEqual(["/workspace/mockup.png"]);
    expect(closed.activeId).toBe("/workspace/mockup.png");
    expect(showConversation(closed).activeId).toBeNull();
    expect(activateArtifact(showConversation(closed), "/workspace/mockup.png").activeId).toBe("/workspace/mockup.png");
    expect(closeArtifact(closed, "/workspace/mockup.png")).toEqual({ activeId: null, tabs: [] });
  });

  it("restores legacy Session pseudo-tabs as the Conversation surface", () => {
    expect(createArtifactWorkspaceState({ activeId: "session", tabs: [] }).activeId).toBeNull();
  });

  it("ignores unsupported files", () => {
    const empty = createArtifactWorkspaceState();
    expect(openArtifact(empty, "SL8JZA5F", "/workspace/.env")).toEqual(empty);
  });

  it("parses quoted CSV and caps the rendered table", () => {
    const parsed = parseDelimitedText('name,note\nAlice,"hello, world"\nBob,"line 1\nline 2"', ",", {
      maxRows: 2,
      maxColumns: 4,
    });

    expect(parsed.rows).toEqual([
      ["name", "note"],
      ["Alice", "hello, world"],
    ]);
    expect(parsed.truncated).toBe(true);
  });
});
