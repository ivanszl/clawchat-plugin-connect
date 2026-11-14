export interface ActiveClawChatTurn {
  chatId: string;
  speakerIds: readonly string[];
}

/**
 * Target rule for `clawchat_send_file`, mirroring the Pi plugin (clawchat-pi src/policy.ts `require`:
 * a speaker that is not the owner may only target the current chat; the owner may target any chat) and the
 * ZeroClaw plugin (plugin/src/grants.rs: cross-chat send_file is limited to `clawchat_send_file`, owner or grant).
 * Connect has no per-speaker grant store, so the cross-chat grant path is unavailable here: only the trusted
 * owner can reach another chat.
 *
 * The CLI call carries no origin, so the origin is inferred from the ClawChat Turns running right now:
 * - no running ClawChat Turn (local CLI use or a Client Interface Turn): trusted local owner, any chat;
 * - every speaker of every running Turn is the owner: any chat;
 * - otherwise: only the chats of the running Turns that have a non-owner speaker.
 */
export function authorizeSendFileTarget(input: {
  chatId: string;
  ownerUserId: string;
  activeTurns: readonly ActiveClawChatTurn[];
}): void {
  const { activeTurns, chatId, ownerUserId } = input;
  const restricted = activeTurns.filter((turn) => turn.speakerIds.some((id) => id !== ownerUserId));
  if (restricted.length === 0) return;
  if (restricted.some((turn) => turn.chatId === chatId)) return;
  throw new Error("Cross-conversation access is not allowed here");
}
