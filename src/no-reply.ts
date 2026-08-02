const CLAWCHAT_NO_REPLY_SOURCE = "clawchat\\s*:\\s*(?:no[-_ ]?reply|silent)(?![A-Za-z0-9_])";
const CLAWCHAT_NO_REPLY_CORE = new RegExp(CLAWCHAT_NO_REPLY_SOURCE, "iu");
const CLAWCHAT_NO_REPLY_STRIP = new RegExp(`[<\\[{\`*_~]*${CLAWCHAT_NO_REPLY_SOURCE}[/>\\]}\`*_~]*`, "giu");
const HOST_SILENCE_MARKERS = new Set(["[SILENT]", "SILENT", "NO_REPLY", "NO REPLY"]);
const EXPLICIT_MEDIA_PATTERN = /!\[[^\]]*\]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/u;

export function containsNoReplySignal(text: string): boolean {
  return CLAWCHAT_NO_REPLY_CORE.test(text) || isHostSilenceMarker(text);
}

export function stripNoReplySignals(text: string): string {
  if (isHostSilenceMarker(text)) return "";
  return text.replace(CLAWCHAT_NO_REPLY_STRIP, "").trim();
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
