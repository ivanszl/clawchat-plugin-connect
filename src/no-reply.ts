const CLAWCHAT_NO_REPLY_SOURCE = "clawchat\\s*(?::\\s*|[-_]\\s*)(?:no[-_ ]?reply|silent)";
const MARKDOWN_DECORATION = "[`*_~]*";
const CLAWCHAT_WRAPPED_NO_REPLY_PREFIX = new RegExp(
  `^\\s*${MARKDOWN_DECORATION}(?:<\\s*${CLAWCHAT_NO_REPLY_SOURCE}\\s*/?\\s*>|\\[\\s*${CLAWCHAT_NO_REPLY_SOURCE}\\s*\\]|\\{\\s*${CLAWCHAT_NO_REPLY_SOURCE}\\s*\\})${MARKDOWN_DECORATION}[ \\t]*`,
  "iu",
);
const CLAWCHAT_BARE_NO_REPLY_PREFIX = new RegExp(
  `^\\s*${MARKDOWN_DECORATION}${CLAWCHAT_NO_REPLY_SOURCE}(?=[\\s\`*_~]|$)${MARKDOWN_DECORATION}[ \\t]*`,
  "iu",
);
const HOST_SILENCE_MARKERS = new Set(["[SILENT]", "SILENT", "NO_REPLY", "NO REPLY"]);
const EXPLICIT_MEDIA_PATTERN = /!\[[^\]]*\]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/u;

export function containsNoReplySignal(text: string): boolean {
  return noReplyPrefix(text) !== null || isHostSilenceMarker(text);
}

export function stripNoReplySignals(text: string): string {
  if (isHostSilenceMarker(text)) return "";
  const prefix = noReplyPrefix(text);
  return prefix ? text.slice(prefix.length).trim() : text;
}

function noReplyPrefix(text: string): string | null {
  return text.match(CLAWCHAT_WRAPPED_NO_REPLY_PREFIX)?.[0] ?? text.match(CLAWCHAT_BARE_NO_REPLY_PREFIX)?.[0] ?? null;
}

export function containsExplicitReplyMedia(text: string): boolean {
  return EXPLICIT_MEDIA_PATTERN.test(text);
}

function isHostSilenceMarker(text: string): boolean {
  const candidate = text.trim();
  if (!candidate || candidate.length > 64) return false;
  const canonical = candidate.toUpperCase().replace(/\s+/gu, " ");
  if (HOST_SILENCE_MARKERS.has(canonical)) return true;
  const characters = [...candidate];
  while (characters[0] !== "[" && characters[0] !== "]" && isPunctuation(characters[0])) characters.shift();
  while (characters.at(-1) !== "[" && characters.at(-1) !== "]" && isPunctuation(characters.at(-1))) {
    characters.pop();
  }
  const punctuationStripped = characters.join("").trim();
  return HOST_SILENCE_MARKERS.has(punctuationStripped.toUpperCase().replace(/\s+/gu, " "));
}

function isPunctuation(value: string | undefined): boolean {
  return value !== undefined && /^\p{P}$/u.test(value);
}
