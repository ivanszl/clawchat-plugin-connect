import type { ChatComposerToken } from "@astryxdesign/core/Chat";
import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import type { SlashSuggestionView } from "../../../src/client-contract";

interface SlashSuggestionItemData {
  description?: string;
  group: string;
  suggestion: SlashSuggestionView;
}

export type SlashSuggestionItem = SearchableItem<SlashSuggestionItemData>;

export function slashSuggestionItems(entries: SlashSuggestionView[]): SlashSuggestionItem[] {
  return entries.map((suggestion) => ({
    id: `${suggestion.kind}:${suggestion.id}`,
    label: `/${suggestion.name}`,
    auxiliaryData: {
      ...(suggestion.description ? { description: suggestion.description } : {}),
      group: suggestion.kind === "skill" ? "Skills" : "Commands",
      suggestion,
    },
  }));
}

export function slashSuggestionFromItem(item: SearchableItem): SlashSuggestionView | null {
  const suggestion = (item.auxiliaryData as Partial<SlashSuggestionItemData> | undefined)?.suggestion;
  if (!suggestion || !["skill", "command"].includes(suggestion.kind)) return null;
  return suggestion;
}

export function slashSuggestionToken(suggestion: SlashSuggestionView): ChatComposerToken {
  return {
    value: `/${suggestion.name}`,
    label: `/${suggestion.name}`,
    variant: suggestion.kind === "skill" ? "purple" : "yellow",
  };
}

export function leadingSlashSuggestion(text: string, entries: SlashSuggestionView[]): SlashSuggestionView | null {
  const name = /^\/([^\s/]+)(?=\s|$)/u.exec(text)?.[1];
  if (!name) return null;
  return entries.find((entry) => entry.name === name) ?? null;
}

export function keepsSlashSelection(value: string, selection: SlashSuggestionView): boolean {
  const prefix = `/${selection.name}`;
  return value === prefix || (value.startsWith(prefix) && /\s/u.test(value[prefix.length] ?? ""));
}
