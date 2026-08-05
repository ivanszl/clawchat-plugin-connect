import { randomBytes } from "node:crypto";
import type { SqliteDb } from "./sqlite";

export interface SessionRefRow {
  session_ref: string;
  chat_id: string;
  agent_id: string;
  session_id: string | null;
  runtime_session_id: string | null;
}

const SESSION_REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SESSION_REF_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u;

export function generateSessionRef(): string {
  const bytes = randomBytes(5);
  let bits = 0;
  let bitCount = 0;
  let result = "";
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      result += SESSION_REF_ALPHABET[(bits >>> bitCount) & 31];
    }
  }
  return result;
}

export function normalizeGeneratedSessionRef(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!SESSION_REF_PATTERN.test(normalized)) throw new Error("Session Ref factory must return 8 Base32 characters");
  return normalized;
}

export function runtimeSessionSelect(): string {
  return "SELECT rs.*, sr.session_ref FROM runtime_sessions rs JOIN session_refs sr ON sr.chat_id = rs.chat_id AND sr.agent_id = rs.agent_id AND sr.session_id = rs.session_id";
}

export function assertSessionRefCanAttach(
  row: SessionRefRow,
  sessionId: string | null,
  runtimeSessionId: string | null,
): void {
  if (sessionId && row.session_id && row.session_id !== sessionId)
    throw new Error(`Runtime Thread is already mapped to Session Ref ${row.session_ref}`);
  if (runtimeSessionId && row.runtime_session_id && row.runtime_session_id !== runtimeSessionId)
    throw new Error(`Session Ref ${row.session_ref} already maps another Runtime Thread`);
}

export async function attachSessionRef(
  db: SqliteDb,
  sessionRef: string,
  sessionId: string | null,
  runtimeSessionId: string | null,
): Promise<void> {
  await db.run(
    "UPDATE session_refs SET session_id = COALESCE(?, session_id), runtime_session_id = COALESCE(?, runtime_session_id), updated_at = ? WHERE session_ref = ?",
    sessionId,
    runtimeSessionId,
    Date.now(),
    sessionRef,
  );
}
