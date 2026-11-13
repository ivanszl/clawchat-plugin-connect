import type { DshSessionEvent } from "../../src/runtime/deepseek-harness-protocol";

export interface DshToolResultMessage {
  source?: { callId?: string };
  content: Array<{ type?: string; toolCallId?: string; isError?: boolean; content: Array<Record<string, unknown>> }>;
}

/** The `data.message` of a `tool/result` event, typed for assertions. */
export function toolResultMessage(event: DshSessionEvent): DshToolResultMessage {
  return (event.data as { message: DshToolResultMessage }).message;
}

/** The content blocks inside the first tool-result of a `tool/result` event. */
export function toolResultBlocks(event: DshSessionEvent): Array<Record<string, unknown>> {
  return toolResultMessage(event).content[0]?.content ?? [];
}
