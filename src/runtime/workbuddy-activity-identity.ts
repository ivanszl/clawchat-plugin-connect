import type { ConnectRuntimePrompt } from "./types";

export function workBuddySubmittedUserMessageId(input: ConnectRuntimePrompt, requestId: number): string {
  const origin = input.turnOrigin === "clawchat" ? "clawchat" : "client";
  const turnId = (input.turnId ?? `request-${requestId}`).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return `clawchat-connect-${origin}-${turnId}`;
}

export function workBuddySubmittedUserHistoryActivityId(input: ConnectRuntimePrompt): string | null {
  return input.turnId ? `workbuddy:user:${workBuddySubmittedUserMessageId(input, 0)}` : null;
}

export function workBuddySubmittedUserLiveNativeId(input: ConnectRuntimePrompt, turnOrdinal: number): string {
  return input.turnId ? `connect:${input.turnId}` : `connect-turn:${turnOrdinal}`;
}

export function workBuddySubmittedUserLiveActivityId(input: ConnectRuntimePrompt): string | null {
  return input.turnId ? `workbuddy:user:${workBuddySubmittedUserLiveNativeId(input, 0)}` : null;
}
