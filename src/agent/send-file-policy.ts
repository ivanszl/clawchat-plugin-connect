import { homedir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { isPathWithin } from "../path-containment";

/** The user's home directory, honouring HOME/USERPROFILE so tests and wrappers can relocate it. */
export function homeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export type SendFileChatType = "direct" | "group";

export interface ActiveClawChatTurn {
  chatId: string;
  chatType: SendFileChatType;
  speakerIds: readonly string[];
}

export interface SendFileAuthorization {
  /** True when a non-owner speaker is running a turn: hidden files and a home-directory Workspace are refused. */
  restricted: boolean;
  chatType: SendFileChatType;
}

/**
 * Target rule for `clawchat_send_file`, mirroring the Pi plugin (clawchat-pi src/policy.ts `require`: a speaker
 * that is not the owner may only target the current chat; the owner may target any chat) and the ZeroClaw plugin
 * (plugin/src/grants.rs: cross-chat send_file is owner or grant). Connect has no per-speaker grant store, so the
 * cross-chat grant path does not exist here.
 *
 * A CLI tool call carries no trustworthy origin: the Runtime process is shared by every turn of the Binding, so a
 * per-turn environment variable or token cannot be injected, and a model-supplied turn id would be attacker
 * influenced. The origin is therefore inferred from the ClawChat Turns running right now, and every ambiguous
 * case fails closed:
 * - no running ClawChat Turn: denied (background or late calls are never trusted);
 * - every running speaker is the owner: any chat;
 * - otherwise the target must be the single chat shared by all running Turns that have a non-owner speaker;
 *   two or more distinct non-owner chats running at once is ambiguous and denied.
 */
export function authorizeSendFileTarget(input: {
  chatId: string;
  requestedChatType?: SendFileChatType;
  ownerUserId: string;
  activeTurns: readonly ActiveClawChatTurn[];
}): SendFileAuthorization {
  const { activeTurns, chatId, ownerUserId } = input;
  if (activeTurns.length === 0) {
    throw new Error(
      "No ClawChat conversation is active; clawchat_send_file only works while answering a ClawChat message",
    );
  }
  const restrictedTurns = activeTurns.filter((turn) => turn.speakerIds.some((id) => id !== ownerUserId));
  const restrictedChats = new Set(restrictedTurns.map((turn) => turn.chatId));
  if (restrictedChats.size > 1) {
    throw new Error(
      "Several conversations are running at once, so the destination is ambiguous; retry after the other conversation finishes",
    );
  }
  if (restrictedChats.size === 1 && !restrictedChats.has(chatId)) {
    throw new Error("Cross-conversation access is not allowed here");
  }
  const known = activeTurns.find((turn) => turn.chatId === chatId)?.chatType;
  if (known && input.requestedChatType && known !== input.requestedChatType) {
    throw new Error(`chat_type does not match the conversation (it is a ${known} chat)`);
  }
  return { restricted: restrictedChats.size > 0, chatType: known ?? input.requestedChatType ?? "direct" };
}

const DENIED_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const DENIED_BASENAMES = new Set([".git-credentials", ".netrc", ".npmrc", ".pypirc"]);
const DENIED_EXTENSIONS = new Set([".pem", ".key"]);

/** Directories that hold Connect and DSH state; never sendable regardless of Workspace. */
export function defaultSecretRoots(extra: readonly string[] = []): string[] {
  const home = homeDirectory();
  return [
    join(home, ".clawchat-connect"),
    join(home, ".clawchat-dsh"),
    join(home, ".dsh"),
    join(home, ".deepseek"),
    ...(process.env.DSH_HOME ? [process.env.DSH_HOME] : []),
    ...extra,
  ];
}

/** Returns a refusal reason for a canonical file path, or null when it may be sent. */
export function sendFileDenyReason(input: {
  resolved: string;
  workspaceRoot: string;
  secretRoots: readonly string[];
  restricted: boolean;
  /** Canonical home directory; defaults to the process home. */
  home?: string;
}): string | null {
  const { resolved, workspaceRoot } = input;
  if (input.secretRoots.some((root) => isPathWithin(root, resolved, { allowEqual: true }))) {
    return "file is in a Connect or DSH state directory and is refused";
  }
  const segments = resolved.split(/[\\/]/u).map((segment) => segment.toLowerCase());
  const name = basename(resolved).toLowerCase();
  if (
    segments.some((segment) => DENIED_SEGMENTS.has(segment)) ||
    segments.some((segment, index) => segment === ".config" && segments[index + 1] === "gh") ||
    DENIED_BASENAMES.has(name) ||
    DENIED_EXTENSIONS.has(extname(name)) ||
    name.startsWith("id_") ||
    /^\.env(\..+)?$/u.test(name)
  ) {
    return "file is in a credential location and is refused";
  }
  if (input.restricted) {
    if (isPathWithin(workspaceRoot, input.home ?? homeDirectory(), { allowEqual: true })) {
      return "the Workspace is the home directory; sending files for another sender is refused";
    }
    const inside = relative(workspaceRoot, resolved).split(/[\\/]/u);
    if (inside.some((segment) => segment.startsWith("."))) return "hidden files are refused for another sender";
  }
  return null;
}
