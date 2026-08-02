import { describe, expect, it } from "bun:test";
import {
  keepsSlashSelection,
  leadingSlashSuggestion,
  slashSuggestionFromItem,
  slashSuggestionItems,
  slashSuggestionToken,
} from "../web/src/features/slash-suggestions";

const skill = {
  kind: "skill" as const,
  id: "codex:review",
  name: "review",
  description: "Review the selected changes",
};

describe("Astryx slash suggestion mapping", () => {
  it("maps Runtime Skills into grouped Typeahead items and reusable Chat tokens", () => {
    const [item] = slashSuggestionItems([skill]);

    expect(item).toMatchObject({
      id: "skill:codex:review",
      label: "/review",
      auxiliaryData: { group: "Skills", suggestion: skill },
    });
    expect(item && slashSuggestionFromItem(item)).toEqual(skill);
    expect(slashSuggestionToken(skill)).toEqual({
      value: "/review",
      label: "/review",
      variant: "purple",
    });
  });

  it("recognizes a leading selection in the transcript without matching ordinary slash text", () => {
    expect(leadingSlashSuggestion("/review the changes", [skill])).toEqual(skill);
    expect(leadingSlashSuggestion("please /review the changes", [skill])).toBeNull();
    expect(leadingSlashSuggestion("/unknown the changes", [skill])).toBeNull();
  });

  it("keeps the selected Runtime Skill across Astryx's non-breaking token separator", () => {
    expect(keepsSlashSelection("/review\u00a0the changes", skill)).toBe(true);
    expect(keepsSlashSelection("/review the changes", skill)).toBe(true);
    expect(keepsSlashSelection("/research the changes", skill)).toBe(false);
  });
});
