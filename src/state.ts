import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { defaultStateDbPath } from "./config";
import {
  type ActivationCredentials,
  type OutputVisibility,
  PLATFORM_ID,
  type ProjectRecord,
  type RuntimeSessionRecord,
  type RuntimeStatus,
} from "./types";

export interface ConnectStateOptions {
  dbPath?: string;
  sessionRefFactory?: () => string;
}

export interface SessionRefTarget {
  chatId: string;
  agentId: string;
  sessionId?: string | null;
  runtimeSessionId?: string | null;
}

class BunSqliteAdapter {
  constructor(private readonly database: Database) {}

  async run(sql: string, ...bindings: SQLQueryBindings[]): Promise<{ changes: number }> {
    return this.database.query<unknown, SQLQueryBindings[]>(sql).run(...bindings);
  }

  async get<T>(sql: string, ...bindings: SQLQueryBindings[]): Promise<T | undefined> {
    return this.database.query<T, SQLQueryBindings[]>(sql).get(...bindings) ?? undefined;
  }

  async all<T>(sql: string, ...bindings: SQLQueryBindings[]): Promise<T> {
    return this.database.query<unknown, SQLQueryBindings[]>(sql).all(...bindings) as T;
  }

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

type SqliteDb = BunSqliteAdapter;
export interface MessageInput {
  agentId?: string | null;
  direction: "inbound" | "outbound";
  kind: "message" | "thinking";
  eventType: string;
  traceId?: string | null;
  chatId?: string | null;
  messageId?: string | null;
  text?: string | null;
  raw?: unknown;
  createdAt?: number;
}
export interface InsertProjectInput {
  projectId: string;
  name: string;
  rootPath: string;
  additionalDirectories?: string[];
}
export interface UpsertRuntimeSessionInput {
  chatId: string;
  sessionId: string;
  agentId: string;
  runtimeSessionId?: string | null;
  projectId?: string | null;
  name?: string | null;
  mode?: string | null;
  isCurrent?: boolean;
}

export class ConnectStateStore {
  readonly dbPath: string;
  private readonly sessionRefFactory: () => string;
  private db: SqliteDb | null = null;
  constructor(options: ConnectStateOptions = {}) {
    this.dbPath = options.dbPath ?? defaultStateDbPath();
    this.sessionRefFactory = options.sessionRefFactory ?? generateSessionRef;
    if (!isAbsolute(this.dbPath)) throw new Error("stateDbPath must be an absolute path");
  }
  async initialize(): Promise<void> {
    if (this.db) return;
    await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new BunSqliteAdapter(new Database(this.dbPath, { create: true }));
    try {
      await this.db.exec("PRAGMA journal_mode = WAL");
      await this.db.exec("PRAGMA foreign_keys = ON");
      await this.createSchema();
      await this.backfillSessionRefs();
      await chmod(this.dbPath, 0o600).catch(() => undefined);
    } catch (error) {
      await this.db.close();
      this.db = null;
      throw error;
    }
  }
  async close(): Promise<void> {
    await this.db?.close();
    this.db = null;
  }

  async upsertActivation(input: ActivationCredentials): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO activations(platform, local_agent_id, access_token, refresh_token, server_agent_id, user_id, owner_user_id, conversation_id, activated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, local_agent_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, server_agent_id = excluded.server_agent_id, user_id = excluded.user_id, owner_user_id = excluded.owner_user_id, conversation_id = excluded.conversation_id, updated_at = excluded.updated_at`,
      PLATFORM_ID,
      input.localAgentId,
      input.accessToken,
      input.refreshToken,
      input.serverAgentId,
      input.userId,
      input.ownerUserId,
      input.conversationId,
      now,
      now,
    );
  }
  async getActivation(localAgentId: string): Promise<ActivationCredentials | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      `SELECT local_agent_id, access_token, refresh_token, server_agent_id, user_id, owner_user_id, conversation_id FROM activations WHERE platform = ? AND local_agent_id = ?`,
      PLATFORM_ID,
      localAgentId,
    );
    if (!row) return null;
    const accessToken = stringValue(row.access_token);
    const userId = stringValue(row.user_id);
    const ownerUserId = stringValue(row.owner_user_id);
    if (!accessToken || !userId || !ownerUserId) return null;
    return {
      localAgentId: stringValue(row.local_agent_id),
      accessToken,
      refreshToken: nullableString(row.refresh_token),
      serverAgentId: nullableString(row.server_agent_id),
      userId,
      ownerUserId,
      conversationId: nullableString(row.conversation_id),
    };
  }
  async getActivationUserId(localAgentId: string): Promise<string | null> {
    return (await this.getActivation(localAgentId))?.userId ?? null;
  }

  async getDeviceId(): Promise<string | null> {
    const db = await this.requireDb();
    const row = await db.get<{ device_id?: string }>("SELECT device_id FROM device_state WHERE id = 1");
    return row?.device_id ?? null;
  }
  async getOrCreateDeviceId(factory: () => string = randomUUID): Promise<string> {
    const existing = await this.getDeviceId();
    if (existing) return existing;
    const deviceId = factory();
    await this.setDeviceId(deviceId);
    return deviceId;
  }
  async setDeviceId(deviceId: string): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO device_state(id, device_id, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, updated_at = excluded.updated_at`,
      deviceId,
      now,
    );
  }
  async getOutputVisibility(chatId: string): Promise<OutputVisibility | null> {
    const db = await this.requireDb();
    const row = await db.get<{ mode?: string }>("SELECT mode FROM output_visibility WHERE chat_id = ?", chatId);
    return row?.mode === "minimal" || row?.mode === "normal" || row?.mode === "full" ? row.mode : null;
  }
  async setOutputVisibility(chatId: string, mode: OutputVisibility): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO output_visibility(chat_id, mode, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      chatId,
      mode,
      now,
    );
  }

  async insertProject(input: InsertProjectInput): Promise<ProjectRecord> {
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO projects(project_id, name, root_path, additional_directories_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      input.projectId,
      input.name,
      input.rootPath,
      JSON.stringify(input.additionalDirectories ?? []),
      now,
      now,
    );
    const project = await this.getProject(input.projectId);
    if (!project) throw new Error(`failed to persist project ${input.projectId}`);
    return project;
  }
  async getProject(reference: string): Promise<ProjectRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      `SELECT * FROM projects WHERE project_id = ? OR name = ? COLLATE NOCASE ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END LIMIT 1`,
      reference,
      reference,
      reference,
    );
    return row ? projectFromRow(row) : null;
  }
  async listProjects(): Promise<ProjectRecord[]> {
    const db = await this.requireDb();
    const rows = await db.all<Record<string, unknown>[]>(`SELECT * FROM projects ORDER BY name COLLATE NOCASE`);
    return rows.map(projectFromRow);
  }
  async countRuntimeSessionsForProject(projectId: string): Promise<number> {
    const db = await this.requireDb();
    const row = await db.get<{ count?: number }>(
      `SELECT COUNT(*) AS count FROM runtime_sessions WHERE project_id = ?`,
      projectId,
    );
    return numberValue(row?.count);
  }
  async deleteProject(projectId: string): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(`DELETE FROM projects WHERE project_id = ?`, projectId);
    return result.changes > 0;
  }

  async upsertRuntimeSession(input: UpsertRuntimeSessionInput): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    if (input.isCurrent !== false)
      await db.run(
        "UPDATE runtime_sessions SET is_current = 0 WHERE chat_id = ? AND agent_id = ?",
        input.chatId,
        input.agentId,
      );
    await db.run(
      `INSERT INTO runtime_sessions(chat_id, session_id, agent_id, runtime_session_id, project_id, name, mode, is_current, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, agent_id, session_id) DO UPDATE SET agent_id = excluded.agent_id, runtime_session_id = excluded.runtime_session_id, project_id = excluded.project_id, name = excluded.name, mode = excluded.mode, is_current = excluded.is_current, updated_at = excluded.updated_at`,
      input.chatId,
      input.sessionId,
      input.agentId,
      input.runtimeSessionId ?? null,
      input.projectId ?? null,
      input.name ?? null,
      input.mode ?? null,
      input.isCurrent === false ? 0 : 1,
      now,
      now,
    );
    const sessionRef = await this.getOrCreateSessionRef({
      chatId: input.chatId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      runtimeSessionId: input.runtimeSessionId,
    });
    if (!input.runtimeSessionId)
      await db.run(
        "UPDATE session_refs SET runtime_session_id = NULL, updated_at = ? WHERE session_ref = ?",
        Date.now(),
        sessionRef,
      );
  }
  async getCurrentRuntimeSession(chatId: string, agentId: string): Promise<RuntimeSessionRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      `${runtimeSessionSelect()} WHERE rs.chat_id = ? AND rs.agent_id = ? AND rs.is_current = 1 ORDER BY rs.updated_at DESC LIMIT 1`,
      chatId,
      agentId,
    );
    return row ? runtimeSessionFromRow(row) : null;
  }
  async listRuntimeSessions(chatId: string, agentId: string): Promise<RuntimeSessionRecord[]> {
    const db = await this.requireDb();
    const rows = await db.all<Record<string, unknown>[]>(
      `${runtimeSessionSelect()} WHERE rs.chat_id = ? AND rs.agent_id = ? ORDER BY rs.updated_at DESC`,
      chatId,
      agentId,
    );
    return rows.map(runtimeSessionFromRow);
  }
  async switchRuntimeSession(chatId: string, agentId: string, sessionId: string): Promise<boolean> {
    const db = await this.requireDb();
    await db.run("UPDATE runtime_sessions SET is_current = 0 WHERE chat_id = ? AND agent_id = ?", chatId, agentId);
    const result = await db.run(
      "UPDATE runtime_sessions SET is_current = 1, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
      Date.now(),
      chatId,
      agentId,
      sessionId,
    );
    return result.changes > 0;
  }
  async setRuntimeSessionId(
    chatId: string,
    agentId: string,
    sessionId: string,
    runtimeSessionId: string | null,
  ): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      "UPDATE runtime_sessions SET runtime_session_id = ?, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
      runtimeSessionId,
      Date.now(),
      chatId,
      agentId,
      sessionId,
    );
    if (result.changes > 0) {
      if (runtimeSessionId) {
        await this.getOrCreateSessionRef({ chatId, agentId, sessionId, runtimeSessionId });
      } else {
        await db.run(
          "UPDATE session_refs SET runtime_session_id = NULL, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
          Date.now(),
          chatId,
          agentId,
          sessionId,
        );
      }
    }
    return result.changes > 0;
  }

  async getOrCreateSessionRef(target: SessionRefTarget): Promise<string> {
    const sessionId = nullableString(target.sessionId);
    const runtimeSessionId = nullableString(target.runtimeSessionId);
    if (!sessionId && !runtimeSessionId) throw new Error("Session Ref requires a Session or Runtime Thread target");
    const db = await this.requireDb();
    const sessionRow = sessionId
      ? await db.get<SessionRefRow>(
          "SELECT * FROM session_refs WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
          target.chatId,
          target.agentId,
          sessionId,
        )
      : undefined;
    const runtimeRow = runtimeSessionId
      ? await db.get<SessionRefRow>(
          "SELECT * FROM session_refs WHERE chat_id = ? AND agent_id = ? AND runtime_session_id = ?",
          target.chatId,
          target.agentId,
          runtimeSessionId,
        )
      : undefined;

    if (sessionRow && runtimeRow && sessionRow.session_ref !== runtimeRow.session_ref) {
      assertSessionRefCanAttach(runtimeRow, sessionId, runtimeSessionId);
      assertSessionRefCanAttach(sessionRow, sessionId, runtimeSessionId);
      await db.run("DELETE FROM session_refs WHERE session_ref = ?", sessionRow.session_ref);
      await attachSessionRef(db, runtimeRow.session_ref, sessionId, runtimeSessionId);
      return runtimeRow.session_ref;
    }

    const existing = runtimeRow ?? sessionRow;
    if (existing) {
      assertSessionRefCanAttach(existing, sessionId, runtimeSessionId);
      await attachSessionRef(db, existing.session_ref, sessionId, runtimeSessionId);
      return existing.session_ref;
    }

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const sessionRef = normalizeGeneratedSessionRef(this.sessionRefFactory());
      const now = Date.now();
      const result = await db.run(
        "INSERT OR IGNORE INTO session_refs(session_ref, chat_id, agent_id, session_id, runtime_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        sessionRef,
        target.chatId,
        target.agentId,
        sessionId,
        runtimeSessionId,
        now,
        now,
      );
      if (result.changes > 0) return sessionRef;
      const concurrent = runtimeSessionId
        ? await db.get<SessionRefRow>(
            "SELECT * FROM session_refs WHERE chat_id = ? AND agent_id = ? AND runtime_session_id = ?",
            target.chatId,
            target.agentId,
            runtimeSessionId,
          )
        : sessionId
          ? await db.get<SessionRefRow>(
              "SELECT * FROM session_refs WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
              target.chatId,
              target.agentId,
              sessionId,
            )
          : undefined;
      if (concurrent) {
        assertSessionRefCanAttach(concurrent, sessionId, runtimeSessionId);
        await attachSessionRef(db, concurrent.session_ref, sessionId, runtimeSessionId);
        return concurrent.session_ref;
      }
    }
    throw new Error("failed to allocate a unique Session Ref");
  }
  async setRuntimeSessionName(chatId: string, agentId: string, sessionId: string, name: string): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      "UPDATE runtime_sessions SET name = ?, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
      name,
      Date.now(),
      chatId,
      agentId,
      sessionId,
    );
    return result.changes > 0;
  }
  async deleteRuntimeSession(chatId: string, agentId: string, sessionId?: string): Promise<boolean> {
    const db = await this.requireDb();
    const targets = await db.all<{ session_id: string; runtime_session_id: string | null }[]>(
      sessionId
        ? "SELECT session_id, runtime_session_id FROM runtime_sessions WHERE chat_id = ? AND agent_id = ? AND session_id = ?"
        : "SELECT session_id, runtime_session_id FROM runtime_sessions WHERE chat_id = ? AND agent_id = ? AND is_current = 1",
      ...(sessionId ? [chatId, agentId, sessionId] : [chatId, agentId]),
    );
    const result = sessionId
      ? await db.run(
          "DELETE FROM runtime_sessions WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
          chatId,
          agentId,
          sessionId,
        )
      : await db.run(
          "DELETE FROM runtime_sessions WHERE chat_id = ? AND agent_id = ? AND is_current = 1",
          chatId,
          agentId,
        );
    for (const target of targets) {
      if (target.runtime_session_id) {
        await db.run(
          "UPDATE session_refs SET session_id = NULL, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
          Date.now(),
          chatId,
          agentId,
          target.session_id,
        );
      } else {
        await db.run(
          "DELETE FROM session_refs WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
          chatId,
          agentId,
          target.session_id,
        );
      }
    }
    return result.changes > 0;
  }

  async claimMessageOnce(input: MessageInput): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      `INSERT OR IGNORE INTO clawchat_messages(platform, local_agent_id, kind, direction, event_type, trace_id, chat_id, message_id, text, raw_json, created_at, send_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      PLATFORM_ID,
      input.agentId ?? "default",
      input.kind,
      input.direction,
      input.eventType,
      input.traceId ?? null,
      input.chatId ?? null,
      input.messageId ?? null,
      input.text ?? null,
      toJson(input.raw),
      input.createdAt ?? Date.now(),
      input.direction === "outbound" ? "pending" : null,
    );
    return (result.changes ?? 0) > 0;
  }
  async markMessageAcknowledged(params: {
    messageId: string;
    protocolMessageId?: string | null;
    ackedAt?: number;
  }): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      `UPDATE clawchat_messages SET send_status = 'acknowledged', protocol_message_id = ?, acked_at = ?, send_error = NULL WHERE direction = 'outbound' AND kind = 'message' AND message_id = ?`,
      params.protocolMessageId ?? params.messageId,
      params.ackedAt ?? Date.now(),
      params.messageId,
    );
    return (result.changes ?? 0) > 0;
  }
  async upsertRuntimeStatus(input: Omit<RuntimeStatus, "updatedAt">): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO runtime_status(id, updated_at, websocket_connected, active_agent, active_chats, global_running, global_queued, recent_error) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, websocket_connected = excluded.websocket_connected, active_agent = excluded.active_agent, active_chats = excluded.active_chats, global_running = excluded.global_running, global_queued = excluded.global_queued, recent_error = excluded.recent_error`,
      now,
      input.websocketConnected == null ? null : input.websocketConnected ? 1 : 0,
      input.activeAgent,
      input.activeChats,
      input.globalRunning,
      input.globalQueued,
      input.recentError,
    );
  }
  async getRuntimeStatus(): Promise<RuntimeStatus | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>("SELECT * FROM runtime_status WHERE id = 1");
    if (!row) return null;
    const connected = row.websocket_connected;
    return {
      updatedAt: numberValue(row.updated_at),
      websocketConnected: connected == null ? null : Boolean(connected),
      activeAgent: nullableString(row.active_agent),
      activeChats: numberValue(row.active_chats),
      globalRunning: numberValue(row.global_running),
      globalQueued: numberValue(row.global_queued),
      recentError: nullableString(row.recent_error),
    };
  }
  private async requireDb(): Promise<SqliteDb> {
    if (!this.db) await this.initialize();
    if (!this.db) throw new Error("clawchat-connect sqlite database is not open");
    return this.db;
  }
  private async createSchema(): Promise<void> {
    const db = await this.requireDb();
    await db.exec(
      `CREATE TABLE IF NOT EXISTS activations(platform TEXT NOT NULL, local_agent_id TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, server_agent_id TEXT, user_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, conversation_id TEXT, activated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(platform, local_agent_id)); CREATE TABLE IF NOT EXISTS device_state(id INTEGER PRIMARY KEY CHECK(id = 1), device_id TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS projects(project_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, root_path TEXT NOT NULL UNIQUE, additional_directories_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS runtime_sessions(chat_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, runtime_session_id TEXT, project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT, name TEXT, mode TEXT, is_current INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, agent_id, session_id)); CREATE TABLE IF NOT EXISTS session_refs(session_ref TEXT PRIMARY KEY COLLATE NOCASE CHECK(length(session_ref) = 8), chat_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT, runtime_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK(session_id IS NOT NULL OR runtime_session_id IS NOT NULL), UNIQUE(chat_id, agent_id, session_id), UNIQUE(chat_id, agent_id, runtime_session_id)); CREATE TABLE IF NOT EXISTS output_visibility(chat_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS clawchat_messages(id INTEGER PRIMARY KEY, platform TEXT NOT NULL, local_agent_id TEXT NOT NULL, kind TEXT NOT NULL, direction TEXT NOT NULL, event_type TEXT NOT NULL, trace_id TEXT, chat_id TEXT, message_id TEXT, text TEXT, raw_json TEXT, created_at INTEGER NOT NULL, send_status TEXT, protocol_message_id TEXT, acked_at INTEGER, send_error TEXT); CREATE UNIQUE INDEX IF NOT EXISTS idx_clawchat_connect_message_unique ON clawchat_messages(local_agent_id, direction, kind, message_id) WHERE kind = 'message' AND message_id IS NOT NULL; CREATE TABLE IF NOT EXISTS runtime_status(id INTEGER PRIMARY KEY CHECK(id = 1), updated_at INTEGER NOT NULL, websocket_connected INTEGER, active_agent TEXT, active_chats INTEGER NOT NULL, global_running INTEGER NOT NULL, global_queued INTEGER NOT NULL, recent_error TEXT);`,
    );
  }

  private async backfillSessionRefs(): Promise<void> {
    const db = await this.requireDb();
    const sessions = await db.all<Record<string, unknown>[]>(
      "SELECT chat_id, agent_id, session_id, runtime_session_id FROM runtime_sessions",
    );
    for (const session of sessions) {
      await this.getOrCreateSessionRef({
        chatId: stringValue(session.chat_id),
        agentId: stringValue(session.agent_id),
        sessionId: stringValue(session.session_id),
        runtimeSessionId: nullableString(session.runtime_session_id),
      });
    }
  }
}
export function createStateStore(options?: ConnectStateOptions): ConnectStateStore {
  return new ConnectStateStore(options);
}
function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
function nullableString(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0;
}
function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return {
    projectId: stringValue(row.project_id),
    name: stringValue(row.name),
    rootPath: stringValue(row.root_path),
    additionalDirectories: stringArrayFromJson(row.additional_directories_json),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}
function stringArrayFromJson(value: unknown): string[] {
  try {
    const parsed = JSON.parse(stringValue(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
function runtimeSessionFromRow(row: Record<string, unknown>): RuntimeSessionRecord {
  return {
    chatId: stringValue(row.chat_id),
    sessionId: stringValue(row.session_id),
    sessionRef: stringValue(row.session_ref),
    agentId: stringValue(row.agent_id),
    runtimeSessionId: nullableString(row.runtime_session_id),
    projectId: nullableString(row.project_id),
    name: nullableString(row.name),
    mode: nullableString(row.mode),
    isCurrent: Boolean(row.is_current),
    updatedAt: numberValue(row.updated_at),
  };
}

interface SessionRefRow {
  session_ref: string;
  session_id: string | null;
  runtime_session_id: string | null;
}

const SESSION_REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SESSION_REF_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u;

function generateSessionRef(): string {
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

function normalizeGeneratedSessionRef(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!SESSION_REF_PATTERN.test(normalized)) throw new Error("Session Ref factory must return 8 Base32 characters");
  return normalized;
}

function runtimeSessionSelect(): string {
  return "SELECT rs.*, sr.session_ref FROM runtime_sessions rs JOIN session_refs sr ON sr.chat_id = rs.chat_id AND sr.agent_id = rs.agent_id AND sr.session_id = rs.session_id";
}

function assertSessionRefCanAttach(
  row: SessionRefRow,
  sessionId: string | null,
  runtimeSessionId: string | null,
): void {
  if (sessionId && row.session_id && row.session_id !== sessionId)
    throw new Error(`Runtime Thread is already mapped to Session Ref ${row.session_ref}`);
  if (runtimeSessionId && row.runtime_session_id && row.runtime_session_id !== runtimeSessionId)
    throw new Error(`Session Ref ${row.session_ref} already maps another Runtime Thread`);
}

async function attachSessionRef(
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
