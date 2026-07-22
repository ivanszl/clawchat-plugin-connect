import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ClientViewEvent, TranscriptBlock } from "./client-contract";
import { defaultStateDbPath } from "./config";
import {
  type ActivationCredentials,
  type OutputVisibility,
  PLATFORM_ID,
  type ProjectRecord,
  type RuntimeSessionRecord,
  type RuntimeStatus,
  type SessionIntentRecord,
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

export interface SessionRefRecord {
  sessionRef: string;
  chatId: string;
  agentId: string;
  sessionId: string | null;
  runtimeSessionId: string | null;
}

class BunSqliteAdapter {
  constructor(private readonly database: Database) {}

  async run(
    sql: string,
    ...bindings: SQLQueryBindings[]
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
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

  transaction<T>(
    callback: (
      run: (sql: string, ...bindings: SQLQueryBindings[]) => { changes: number; lastInsertRowid: number | bigint },
    ) => T,
  ): T {
    return this.database.transaction(() =>
      callback((sql, ...bindings) => this.database.query<unknown, SQLQueryBindings[]>(sql).run(...bindings)),
    )();
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
export interface ProtocolDeliveryInput {
  agentId: string;
  ackEpoch: string;
  dseq: number;
  eventKey: string;
  eventType: string;
  traceId: string;
  chatId?: string | null;
  messageId?: string | null;
  raw: unknown;
}
export interface ProtocolDeliveryState {
  ackEpoch: string;
  lastReadDseq: number;
  ackHighWater: number;
}
export interface ProtocolDeliveryQuarantineInput {
  agentId: string;
  ackEpoch: string;
  dseq: number;
  eventType: string;
  traceId: string;
  raw: unknown;
  error: string;
}
export interface ProtocolDeliveryQuarantineRecord {
  ackEpoch: string;
  dseq: number;
  eventType: string;
  traceId: string;
  raw: unknown;
  error: string;
  createdAt: number;
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
  hasMessages?: boolean;
  isCurrent?: boolean;
}
export interface SetSessionIntentInput {
  chatId: string;
  agentId: string;
  projectId: string | null;
  name?: string | null;
  mode?: string | null;
}

export interface StoredClientEvent {
  cursor: number;
  event: ClientViewEvent;
  createdAt: number;
}

export type ClientCommandClaim =
  | { state: "claimed" }
  | { state: "pending" }
  | { state: "conflict" }
  | { state: "complete"; responseStatus: number; responseBody: unknown };

export type TranscriptBlockInput<T extends TranscriptBlock = TranscriptBlock> = T extends TranscriptBlock
  ? Omit<T, "sequence" | "revision" | "createdAt" | "updatedAt"> & {
      id: string;
      revision?: number;
      createdAt?: string;
      updatedAt?: string;
    }
  : never;

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
      await this.migrateSchema();
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
  async beginProtocolDeliveryEpoch(agentId: string, ackEpoch: string): Promise<void> {
    const normalizedAgentId = requireStateString(agentId, "agentId");
    const normalizedEpoch = requireStateString(ackEpoch, "ackEpoch");
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO protocol_delivery_state(local_agent_id, ack_epoch, last_read_dseq, ack_high_water, updated_at)
       VALUES (?, ?, 0, 0, ?)
       ON CONFLICT(local_agent_id) DO UPDATE SET
         ack_epoch = excluded.ack_epoch,
         last_read_dseq = 0,
         ack_high_water = 0,
         updated_at = excluded.updated_at`,
      normalizedAgentId,
      normalizedEpoch,
      Date.now(),
    );
  }
  async getProtocolDeliveryState(agentId: string): Promise<ProtocolDeliveryState | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      "SELECT ack_epoch, last_read_dseq, ack_high_water FROM protocol_delivery_state WHERE local_agent_id = ?",
      requireStateString(agentId, "agentId"),
    );
    if (!row) return null;
    return {
      ackEpoch: stringValue(row.ack_epoch),
      lastReadDseq: numberValue(row.last_read_dseq),
      ackHighWater: numberValue(row.ack_high_water),
    };
  }
  async recordProtocolDelivery(input: ProtocolDeliveryInput): Promise<"inserted" | "updated" | "duplicate"> {
    const agentId = requireStateString(input.agentId, "agentId");
    const ackEpoch = requireStateString(input.ackEpoch, "ackEpoch");
    const eventKey = requireStateString(input.eventKey, "eventKey");
    const eventType = requireStateString(input.eventType, "eventType");
    const traceId = requireStateString(input.traceId, "traceId");
    if (!Number.isSafeInteger(input.dseq) || input.dseq <= 0) throw new Error("dseq must be a positive integer");
    const db = await this.requireDb();
    const deliveryState = await this.getProtocolDeliveryState(agentId);
    if (!deliveryState || deliveryState.ackEpoch !== ackEpoch)
      throw new Error(`protocol delivery epoch mismatch for ${agentId}`);
    if (input.dseq !== deliveryState.lastReadDseq + 1)
      throw new Error(`protocol delivery dseq gap: expected ${deliveryState.lastReadDseq + 1}, received ${input.dseq}`);
    const rawJson = toJson(input.raw) ?? "null";
    const deliveryContent = protocolDeliveryContentJson(input.raw);
    const existing = await db.get<{ raw_json?: string }>(
      "SELECT raw_json FROM protocol_inbox WHERE local_agent_id = ? AND event_key = ?",
      agentId,
      eventKey,
    );
    const result = !existing
      ? "inserted"
      : protocolDeliveryContentJson(existing.raw_json) === deliveryContent
        ? "duplicate"
        : "updated";
    const now = Date.now();
    db.transaction((run) => {
      run(
        `INSERT INTO protocol_inbox(local_agent_id, event_key, event_type, trace_id, chat_id, message_id, raw_json, first_received_at, last_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_agent_id, event_key) DO UPDATE SET
           event_type = excluded.event_type,
           trace_id = excluded.trace_id,
           chat_id = excluded.chat_id,
           message_id = excluded.message_id,
           raw_json = excluded.raw_json,
           last_received_at = excluded.last_received_at`,
        agentId,
        eventKey,
        eventType,
        traceId,
        input.chatId ?? null,
        input.messageId ?? null,
        rawJson,
        now,
        now,
      );
      run(
        `UPDATE protocol_delivery_state
         SET last_read_dseq = ?, ack_high_water = ?, updated_at = ?
         WHERE local_agent_id = ? AND ack_epoch = ?`,
        input.dseq,
        input.dseq,
        now,
        agentId,
        ackEpoch,
      );
    });
    return result;
  }
  async quarantineProtocolDelivery(input: ProtocolDeliveryQuarantineInput): Promise<void> {
    const agentId = requireStateString(input.agentId, "agentId");
    const ackEpoch = requireStateString(input.ackEpoch, "ackEpoch");
    const eventType = requireStateString(input.eventType, "eventType");
    const traceId = requireStateString(input.traceId, "traceId");
    const error = requireStateString(input.error, "error");
    if (!Number.isSafeInteger(input.dseq) || input.dseq <= 0) throw new Error("dseq must be a positive integer");
    const db = await this.requireDb();
    const deliveryState = await this.getProtocolDeliveryState(agentId);
    if (!deliveryState || deliveryState.ackEpoch !== ackEpoch)
      throw new Error(`protocol delivery epoch mismatch for ${agentId}`);
    if (input.dseq !== deliveryState.lastReadDseq + 1)
      throw new Error(`protocol delivery dseq gap: expected ${deliveryState.lastReadDseq + 1}, received ${input.dseq}`);
    const now = Date.now();
    db.transaction((run) => {
      run(
        `INSERT INTO protocol_delivery_quarantine(local_agent_id, ack_epoch, dseq, event_type, trace_id, raw_json, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_agent_id, ack_epoch, dseq) DO UPDATE SET
           event_type = excluded.event_type,
           trace_id = excluded.trace_id,
           raw_json = excluded.raw_json,
           error = excluded.error`,
        agentId,
        ackEpoch,
        input.dseq,
        eventType,
        traceId,
        toJson(input.raw) ?? "null",
        error,
        now,
      );
      run(
        `UPDATE protocol_delivery_state
         SET last_read_dseq = ?, ack_high_water = ?, updated_at = ?
         WHERE local_agent_id = ? AND ack_epoch = ?`,
        input.dseq,
        input.dseq,
        now,
        agentId,
        ackEpoch,
      );
    });
  }
  async advanceProtocolDelivery(agentId: string, ackEpoch: string, dseq: number): Promise<void> {
    const normalizedAgentId = requireStateString(agentId, "agentId");
    const normalizedEpoch = requireStateString(ackEpoch, "ackEpoch");
    if (!Number.isSafeInteger(dseq) || dseq <= 0) throw new Error("dseq must be a positive integer");
    const db = await this.requireDb();
    const deliveryState = await this.getProtocolDeliveryState(normalizedAgentId);
    if (!deliveryState || deliveryState.ackEpoch !== normalizedEpoch)
      throw new Error(`protocol delivery epoch mismatch for ${normalizedAgentId}`);
    if (dseq !== deliveryState.lastReadDseq + 1)
      throw new Error(`protocol delivery dseq gap: expected ${deliveryState.lastReadDseq + 1}, received ${dseq}`);
    await db.run(
      `UPDATE protocol_delivery_state
       SET last_read_dseq = ?, ack_high_water = ?, updated_at = ?
       WHERE local_agent_id = ? AND ack_epoch = ?`,
      dseq,
      dseq,
      Date.now(),
      normalizedAgentId,
      normalizedEpoch,
    );
  }
  async listProtocolDeliveryQuarantine(agentId: string): Promise<ProtocolDeliveryQuarantineRecord[]> {
    const db = await this.requireDb();
    const rows = await db.all<Record<string, unknown>[]>(
      `SELECT ack_epoch, dseq, event_type, trace_id, raw_json, error, created_at
       FROM protocol_delivery_quarantine
       WHERE local_agent_id = ?
       ORDER BY created_at, dseq`,
      requireStateString(agentId, "agentId"),
    );
    return rows.map((row) => ({
      ackEpoch: stringValue(row.ack_epoch),
      dseq: numberValue(row.dseq),
      eventType: stringValue(row.event_type),
      traceId: stringValue(row.trace_id),
      raw: parseJsonValue(row.raw_json),
      error: stringValue(row.error),
      createdAt: numberValue(row.created_at),
    }));
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
  async countSessionIntentsForProject(projectId: string): Promise<number> {
    const db = await this.requireDb();
    const row = await db.get<{ count?: number }>(
      `SELECT COUNT(*) AS count FROM session_intents WHERE project_id = ?`,
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
    if (input.isCurrent !== false) {
      await db.run(
        "UPDATE runtime_sessions SET is_current = 0 WHERE chat_id = ? AND agent_id = ?",
        input.chatId,
        input.agentId,
      );
      await db.run("DELETE FROM session_intents WHERE chat_id = ? AND agent_id = ?", input.chatId, input.agentId);
    }
    await db.run(
      `INSERT INTO runtime_sessions(chat_id, session_id, agent_id, runtime_session_id, project_id, name, mode, has_messages, is_current, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, agent_id, session_id) DO UPDATE SET agent_id = excluded.agent_id, runtime_session_id = excluded.runtime_session_id, project_id = excluded.project_id, name = excluded.name, mode = excluded.mode, has_messages = CASE WHEN runtime_sessions.has_messages = 1 OR excluded.has_messages = 1 THEN 1 ELSE 0 END, is_current = excluded.is_current, updated_at = excluded.updated_at`,
      input.chatId,
      input.sessionId,
      input.agentId,
      input.runtimeSessionId ?? null,
      input.projectId ?? null,
      input.name ?? null,
      input.mode ?? null,
      input.hasMessages === false ? 0 : 1,
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

  async setSessionIntent(input: SetSessionIntentInput): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      "UPDATE runtime_sessions SET is_current = 0 WHERE chat_id = ? AND agent_id = ?",
      input.chatId,
      input.agentId,
    );
    await db.run(
      `INSERT INTO session_intents(chat_id, agent_id, project_id, name, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, agent_id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, mode = excluded.mode, updated_at = excluded.updated_at`,
      input.chatId,
      input.agentId,
      input.projectId,
      input.name ?? null,
      input.mode ?? null,
      now,
      now,
    );
  }
  async getSessionIntent(chatId: string, agentId: string): Promise<SessionIntentRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      "SELECT * FROM session_intents WHERE chat_id = ? AND agent_id = ?",
      chatId,
      agentId,
    );
    return row ? sessionIntentFromRow(row) : null;
  }
  async clearSessionIntent(chatId: string, agentId: string): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run("DELETE FROM session_intents WHERE chat_id = ? AND agent_id = ?", chatId, agentId);
    return result.changes > 0;
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
  async listAllRuntimeSessions(): Promise<RuntimeSessionRecord[]> {
    const db = await this.requireDb();
    const rows = await db.all<Record<string, unknown>[]>(`${runtimeSessionSelect()} ORDER BY rs.updated_at DESC`);
    return rows.map(runtimeSessionFromRow);
  }
  async getRuntimeSessionByRef(sessionRef: string): Promise<RuntimeSessionRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      `${runtimeSessionSelect()} WHERE sr.session_ref = ? COLLATE NOCASE LIMIT 1`,
      sessionRef,
    );
    return row ? runtimeSessionFromRow(row) : null;
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
    if (result.changes > 0)
      await db.run("DELETE FROM session_intents WHERE chat_id = ? AND agent_id = ?", chatId, agentId);
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

  async setRuntimeSessionProject(
    chatId: string,
    agentId: string,
    sessionId: string,
    projectId: string,
  ): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      "UPDATE runtime_sessions SET project_id = ?, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
      projectId,
      Date.now(),
      chatId,
      agentId,
      sessionId,
    );
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
  async getSessionRefTarget(sessionRef: string): Promise<SessionRefRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<SessionRefRow>(
      "SELECT * FROM session_refs WHERE session_ref = ? COLLATE NOCASE",
      sessionRef,
    );
    if (!row) return null;
    return {
      sessionRef: row.session_ref,
      chatId: row.chat_id,
      agentId: row.agent_id,
      sessionId: nullableString(row.session_id),
      runtimeSessionId: nullableString(row.runtime_session_id),
    };
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

  async deleteSessionByRef(sessionRef: string): Promise<boolean> {
    const db = await this.requireDb();
    const target = await db.get<SessionRefRow>(
      "SELECT * FROM session_refs WHERE session_ref = ? COLLATE NOCASE",
      sessionRef,
    );
    if (!target) return false;
    return db.transaction((run) => {
      if (target.session_id) {
        run(
          "DELETE FROM runtime_sessions WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
          target.chat_id,
          target.agent_id,
          target.session_id,
        );
      }
      const result = run("DELETE FROM session_refs WHERE session_ref = ? COLLATE NOCASE", sessionRef);
      return result.changes > 0;
    });
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
  async upsertInboundMessage(input: MessageInput): Promise<"inserted" | "updated" | "duplicate"> {
    const agentId = requireStateString(input.agentId ?? "", "agentId");
    const messageId = requireStateString(input.messageId ?? "", "messageId");
    if (input.direction !== "inbound" || input.kind !== "message")
      throw new Error("upsertInboundMessage requires an inbound message");
    const db = await this.requireDb();
    const rawJson = toJson(input.raw) ?? "null";
    const existing = await db.get<{ raw_json?: string }>(
      `SELECT raw_json FROM clawchat_messages
       WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?`,
      agentId,
      messageId,
    );
    if (!existing) {
      await db.run(
        `INSERT INTO clawchat_messages(platform, local_agent_id, kind, direction, event_type, trace_id, chat_id, message_id, text, raw_json, created_at, send_status)
         VALUES (?, ?, 'message', 'inbound', ?, ?, ?, ?, ?, ?, ?, NULL)`,
        PLATFORM_ID,
        agentId,
        input.eventType,
        input.traceId ?? null,
        input.chatId ?? null,
        messageId,
        input.text ?? null,
        rawJson,
        input.createdAt ?? Date.now(),
      );
      return "inserted";
    }
    if (protocolDeliveryContentJson(existing.raw_json) === protocolDeliveryContentJson(input.raw)) return "duplicate";
    await db.run(
      `UPDATE clawchat_messages
       SET event_type = ?, trace_id = ?, chat_id = ?, text = ?, raw_json = ?, created_at = ?,
           handled_content_json = NULL, handled_at = NULL
       WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?`,
      input.eventType,
      input.traceId ?? null,
      input.chatId ?? null,
      input.text ?? null,
      rawJson,
      input.createdAt ?? Date.now(),
      agentId,
      messageId,
    );
    return "updated";
  }
  async hasHandledInboundMessage(agentId: string, messageId: string, raw: unknown): Promise<boolean> {
    const db = await this.requireDb();
    const row = await db.get<{ handled_content_json?: string | null }>(
      `SELECT handled_content_json FROM clawchat_messages
       WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?`,
      requireStateString(agentId, "agentId"),
      requireStateString(messageId, "messageId"),
    );
    return row?.handled_content_json === protocolDeliveryContentJson(raw);
  }
  async markInboundMessageHandled(agentId: string, messageId: string, raw: unknown): Promise<void> {
    const db = await this.requireDb();
    const normalizedAgentId = requireStateString(agentId, "agentId");
    const normalizedMessageId = requireStateString(messageId, "messageId");
    const current = await db.get<{ raw_json?: string }>(
      `SELECT raw_json FROM clawchat_messages
       WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?`,
      normalizedAgentId,
      normalizedMessageId,
    );
    if (!current) throw new Error(`inbound message was not persisted before handling: ${messageId}`);
    if (protocolDeliveryContentJson(current.raw_json) !== protocolDeliveryContentJson(raw)) return;
    const result = await db.run(
      `UPDATE clawchat_messages
       SET handled_content_json = ?, handled_at = ?
       WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?
         AND raw_json = ?`,
      protocolDeliveryContentJson(raw),
      Date.now(),
      normalizedAgentId,
      normalizedMessageId,
      current.raw_json ?? null,
    );
    // A concurrent coalesced update deliberately wins. Its own handler will
    // write the completion marker for the newer content.
    if ((result.changes ?? 0) === 0) return;
  }
  async listUnhandledInboundMessages(agentId: string): Promise<unknown[]> {
    const db = await this.requireDb();
    const rows = await db.all<Array<{ raw_json?: string; handled_content_json?: string | null }>>(
      `SELECT raw_json, handled_content_json FROM clawchat_messages
       WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND handled_content_json IS NULL
       ORDER BY created_at, id`,
      requireStateString(agentId, "agentId"),
    );
    return rows.flatMap((row) => {
      const raw = parseJsonValue(row.raw_json);
      return row.handled_content_json === protocolDeliveryContentJson(raw) ? [] : [raw];
    });
  }
  async claimProtocolEvent(agentId: string, eventId: string): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      `INSERT OR IGNORE INTO protocol_event_dedup(local_agent_id, event_id, created_at) VALUES (?, ?, ?)`,
      requireStateString(agentId, "agentId"),
      requireStateString(eventId, "eventId"),
      Date.now(),
    );
    return (result.changes ?? 0) > 0;
  }
  async hasProtocolEvent(agentId: string, eventId: string): Promise<boolean> {
    const db = await this.requireDb();
    const existing = await db.get<{ present: number }>(
      `SELECT 1 AS present FROM protocol_event_dedup WHERE local_agent_id = ? AND event_id = ? LIMIT 1`,
      requireStateString(agentId, "agentId"),
      requireStateString(eventId, "eventId"),
    );
    return existing !== undefined;
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
  async markMessageFailed(params: {
    messageId: string;
    protocolMessageId?: string | null;
    rejectedAt?: number;
    error: string;
  }): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      `UPDATE clawchat_messages SET send_status = 'failed', protocol_message_id = ?, rejected_at = ?, send_error = ? WHERE direction = 'outbound' AND kind = 'message' AND message_id = ?`,
      params.protocolMessageId ?? null,
      params.rejectedAt ?? Date.now(),
      params.error,
      params.messageId,
    );
    return (result.changes ?? 0) > 0;
  }
  async upsertRuntimeStatus(input: Omit<RuntimeStatus, "updatedAt">): Promise<void> {
    if (!input.activeAgent) throw new Error("runtime status requires an Agent Binding id");
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO runtime_statuses(agent_id, updated_at, websocket_connected, active_chats, global_running, global_queued, recent_error) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET updated_at = excluded.updated_at, websocket_connected = excluded.websocket_connected, active_chats = excluded.active_chats, global_running = excluded.global_running, global_queued = excluded.global_queued, recent_error = excluded.recent_error`,
      input.activeAgent,
      now,
      input.websocketConnected == null ? null : input.websocketConnected ? 1 : 0,
      input.activeChats,
      input.globalRunning,
      input.globalQueued,
      input.recentError,
    );
  }
  async setRuntimeConnectionStatus(
    agentId: string,
    websocketConnected: boolean,
    recentError: string | null,
  ): Promise<void> {
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO runtime_statuses(agent_id, updated_at, websocket_connected, active_chats, global_running, global_queued, recent_error) VALUES (?, ?, ?, 0, 0, 0, ?) ON CONFLICT(agent_id) DO UPDATE SET updated_at = excluded.updated_at, websocket_connected = excluded.websocket_connected, recent_error = excluded.recent_error`,
      agentId,
      Date.now(),
      websocketConnected ? 1 : 0,
      recentError,
    );
  }
  async getRuntimeStatus(agentId: string): Promise<RuntimeStatus | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>("SELECT * FROM runtime_statuses WHERE agent_id = ?", agentId);
    if (!row) return null;
    const connected = row.websocket_connected;
    return {
      updatedAt: numberValue(row.updated_at),
      websocketConnected: connected == null ? null : Boolean(connected),
      activeAgent: stringValue(row.agent_id),
      activeChats: numberValue(row.active_chats),
      globalRunning: numberValue(row.global_running),
      globalQueued: numberValue(row.global_queued),
      recentError: nullableString(row.recent_error),
    };
  }

  async deleteExpiredClientCommands(now = Date.now()): Promise<void> {
    const db = await this.requireDb();
    await db.run("DELETE FROM client_commands WHERE created_at < ?", now - 24 * 60 * 60 * 1_000);
  }

  async claimClientCommand(requestId: string, commandKind: string, entityRef: string): Promise<ClientCommandClaim> {
    const db = await this.requireDb();
    const inserted = await db.run(
      "INSERT OR IGNORE INTO client_commands(request_id, command_kind, entity_ref, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL)",
      requestId,
      commandKind,
      entityRef,
      Date.now(),
    );
    if (inserted.changes > 0) return { state: "claimed" };
    const row = await db.get<{
      command_kind: string;
      entity_ref: string;
      response_status: number | null;
      response_json: string | null;
    }>(
      "SELECT command_kind, entity_ref, response_status, response_json FROM client_commands WHERE request_id = ?",
      requestId,
    );
    if (!row || row.command_kind !== commandKind || row.entity_ref !== entityRef) {
      return { state: "conflict" };
    }
    if (row.response_status == null || row.response_json == null) return { state: "pending" };
    try {
      return { state: "complete", responseStatus: row.response_status, responseBody: JSON.parse(row.response_json) };
    } catch {
      throw new Error("stored Client command response is invalid");
    }
  }

  async completeClientCommand(requestId: string, responseStatus: number, responseBody: unknown): Promise<void> {
    const db = await this.requireDb();
    await db.run(
      "UPDATE client_commands SET response_status = ?, response_json = ?, completed_at = ? WHERE request_id = ? AND response_status IS NULL",
      responseStatus,
      JSON.stringify(responseBody),
      Date.now(),
      requestId,
    );
  }

  async abandonClientCommand(requestId: string): Promise<void> {
    const db = await this.requireDb();
    await db.run("DELETE FROM client_commands WHERE request_id = ? AND response_status IS NULL", requestId);
  }

  async upsertTranscriptBlock(
    sessionRef: string,
    input: TranscriptBlockInput,
  ): Promise<{ block: TranscriptBlock; cursor: number }> {
    const db = await this.requireDb();
    const existing = await db.get<{ sequence: number; revision: number; created_at: number; block_json: string }>(
      "SELECT sequence, revision, created_at, block_json FROM transcript_blocks WHERE session_ref = ? AND block_id = ?",
      sessionRef,
      input.id,
    );
    if (existing) {
      try {
        const stored = JSON.parse(existing.block_json) as TranscriptBlock;
        if (sameTranscriptPayload(stored, input)) return { block: stored, cursor: 0 };
      } catch {
        // Replace malformed projection JSON below.
      }
    }
    const now = Date.now();
    const sequence =
      existing?.sequence ??
      numberValue(
        (
          await db.get<{ sequence?: number }>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM transcript_blocks WHERE session_ref = ?",
            sessionRef,
          )
        )?.sequence,
      );
    const revision = Math.max(input.revision ?? (existing?.revision ?? 0) + 1, (existing?.revision ?? 0) + 1);
    const createdAt = input.createdAt ? Date.parse(input.createdAt) : (existing?.created_at ?? now);
    const updatedAt = input.updatedAt ? Date.parse(input.updatedAt) : now;
    const block = {
      ...input,
      revision,
      sequence,
      createdAt: new Date(Number.isFinite(createdAt) ? createdAt : now).toISOString(),
      updatedAt: new Date(Number.isFinite(updatedAt) ? updatedAt : now).toISOString(),
    } as TranscriptBlock;
    await db.run(
      `INSERT INTO transcript_blocks(session_ref, block_id, revision, sequence, block_type, origin, state, plain_text, block_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_ref, block_id) DO UPDATE SET revision = excluded.revision, block_type = excluded.block_type, origin = excluded.origin, state = excluded.state, plain_text = excluded.plain_text, block_json = excluded.block_json, updated_at = excluded.updated_at`,
      sessionRef,
      block.id,
      block.revision,
      block.sequence,
      block.type,
      block.origin,
      block.state,
      block.plainText,
      JSON.stringify(block),
      Date.parse(block.createdAt),
      Date.parse(block.updatedAt),
    );
    const eventWithoutCursor = {
      type: "transcript.block-upserted",
      cursor: 0,
      sessionRef,
      revision: block.revision,
      block,
    } satisfies ClientViewEvent;
    const eventInsert = await db.run(
      "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      eventWithoutCursor.type,
      sessionRef,
      block.revision,
      JSON.stringify(eventWithoutCursor),
      now,
    );
    const cursor = Number(eventInsert.lastInsertRowid);
    return { block, cursor };
  }

  async countTranscriptBlocks(sessionRef: string): Promise<number> {
    const db = await this.requireDb();
    const row = await db.get<{ count?: number }>(
      "SELECT COUNT(*) AS count FROM transcript_blocks WHERE session_ref = ?",
      sessionRef,
    );
    return numberValue(row?.count);
  }

  async rekeyMatchingTranscriptMessage(
    sessionRef: string,
    input: Extract<TranscriptBlockInput, { type: "message" }>,
  ): Promise<TranscriptBlock | null> {
    const db = await this.requireDb();
    const stable = await db.get<{ block_id: string }>(
      "SELECT block_id FROM transcript_blocks WHERE session_ref = ? AND block_id = ?",
      sessionRef,
      input.id,
    );
    if (stable) return null;
    const rows = await db.all<
      Array<{ block_id: string; revision: number; sequence: number; created_at: number; block_json: string }>
    >(
      "SELECT block_id, revision, sequence, created_at, block_json FROM transcript_blocks WHERE session_ref = ? AND block_type = 'message' AND plain_text = ? ORDER BY sequence DESC LIMIT 20",
      sessionRef,
      input.plainText,
    );
    const candidate = rows.find((row) => {
      if (row.block_id.startsWith("b_")) return false;
      try {
        const block = JSON.parse(row.block_json) as TranscriptBlock;
        if (block.type !== "message" || block.role !== input.role) return false;
        return block.origin === input.origin || (input.origin === "runtime" && block.origin === "client");
      } catch {
        return false;
      }
    });
    if (!candidate) return null;
    const previous = JSON.parse(candidate.block_json) as Extract<TranscriptBlock, { type: "message" }>;
    const now = Date.now();
    const block: TranscriptBlock = {
      ...input,
      origin: previous.origin,
      author: previous.author,
      revision: candidate.revision + 1,
      sequence: candidate.sequence,
      createdAt: new Date(candidate.created_at).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    await db.run(
      "UPDATE transcript_blocks SET block_id = ?, revision = ?, origin = ?, state = ?, plain_text = ?, block_json = ?, updated_at = ? WHERE session_ref = ? AND block_id = ?",
      block.id,
      block.revision,
      block.origin,
      block.state,
      block.plainText,
      JSON.stringify(block),
      now,
      sessionRef,
      candidate.block_id,
    );
    const removed = {
      type: "transcript.block-removed",
      cursor: 0,
      sessionRef,
      revision: block.revision,
      blockId: candidate.block_id,
    } satisfies ClientViewEvent;
    await db.run(
      "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      removed.type,
      sessionRef,
      removed.revision,
      JSON.stringify(removed),
      now,
    );
    const upserted = {
      type: "transcript.block-upserted",
      cursor: 0,
      sessionRef,
      revision: block.revision,
      block,
    } satisfies ClientViewEvent;
    await db.run(
      "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      upserted.type,
      sessionRef,
      upserted.revision,
      JSON.stringify(upserted),
      now,
    );
    return block;
  }

  async listTranscriptBlocks(
    sessionRef: string,
    options: { beforeSequence?: number | null; limit?: number } = {},
  ): Promise<TranscriptBlock[]> {
    const db = await this.requireDb();
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
    const before = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const rows = await db.all<{ block_json: string }[]>(
      "SELECT block_json FROM transcript_blocks WHERE session_ref = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?",
      sessionRef,
      before,
      limit,
    );
    return rows
      .flatMap((row) => {
        try {
          return [JSON.parse(row.block_json) as TranscriptBlock];
        } catch {
          return [];
        }
      })
      .reverse();
  }

  async getClientEventCursor(): Promise<number> {
    const db = await this.requireDb();
    return numberValue(
      (await db.get<{ cursor?: number }>("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM client_events"))?.cursor,
    );
  }

  async listClientEvents(afterCursor: number, limit = 500): Promise<StoredClientEvent[]> {
    const db = await this.requireDb();
    const rows = await db.all<Array<{ cursor: number; event_json: string; created_at: number }>>(
      "SELECT cursor, event_json, created_at FROM client_events WHERE cursor > ? ORDER BY cursor ASC LIMIT ?",
      afterCursor,
      Math.max(1, Math.min(1_000, Math.trunc(limit))),
    );
    return rows.flatMap((row) => {
      try {
        const event = JSON.parse(row.event_json) as ClientViewEvent;
        return [
          { cursor: row.cursor, event: { ...event, cursor: row.cursor } as ClientViewEvent, createdAt: row.created_at },
        ];
      } catch {
        return [];
      }
    });
  }
  private async requireDb(): Promise<SqliteDb> {
    if (!this.db) await this.initialize();
    if (!this.db) throw new Error("clawchat-connect sqlite database is not open");
    return this.db;
  }
  private async createSchema(): Promise<void> {
    const db = await this.requireDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS activations(
        platform TEXT NOT NULL,
        local_agent_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        server_agent_id TEXT,
        user_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        conversation_id TEXT,
        activated_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(platform, local_agent_id)
      );
      CREATE TABLE IF NOT EXISTS device_state(
        id INTEGER PRIMARY KEY CHECK(id = 1),
        device_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects(
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        root_path TEXT NOT NULL UNIQUE,
        additional_directories_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_sessions(
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        runtime_session_id TEXT,
        project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
        name TEXT,
        mode TEXT,
        has_messages INTEGER NOT NULL DEFAULT 0,
        is_current INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, agent_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS session_intents(
        chat_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
        name TEXT,
        mode TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS session_refs(
        session_ref TEXT PRIMARY KEY COLLATE NOCASE CHECK(length(session_ref) = 8),
        chat_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        runtime_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(session_id IS NOT NULL OR runtime_session_id IS NOT NULL),
        UNIQUE(chat_id, agent_id, session_id),
        UNIQUE(chat_id, agent_id, runtime_session_id)
      );
      CREATE TABLE IF NOT EXISTS output_visibility(
        chat_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clawchat_messages(
        id INTEGER PRIMARY KEY,
        platform TEXT NOT NULL,
        local_agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        event_type TEXT NOT NULL,
        trace_id TEXT,
        chat_id TEXT,
        message_id TEXT,
        text TEXT,
        raw_json TEXT,
        created_at INTEGER NOT NULL,
        send_status TEXT,
        protocol_message_id TEXT,
        acked_at INTEGER,
        rejected_at INTEGER,
        send_error TEXT,
        handled_content_json TEXT,
        handled_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clawchat_connect_message_unique
        ON clawchat_messages(local_agent_id, direction, kind, message_id)
        WHERE kind = 'message' AND message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS protocol_delivery_state(
        local_agent_id TEXT PRIMARY KEY,
        ack_epoch TEXT NOT NULL,
        last_read_dseq INTEGER NOT NULL,
        ack_high_water INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS protocol_inbox(
        local_agent_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        chat_id TEXT,
        message_id TEXT,
        raw_json TEXT NOT NULL,
        first_received_at INTEGER NOT NULL,
        last_received_at INTEGER NOT NULL,
        PRIMARY KEY(local_agent_id, event_key)
      );
      CREATE TABLE IF NOT EXISTS protocol_delivery_quarantine(
        local_agent_id TEXT NOT NULL,
        ack_epoch TEXT NOT NULL,
        dseq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(local_agent_id, ack_epoch, dseq)
      );
      CREATE TABLE IF NOT EXISTS protocol_event_dedup(
        local_agent_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(local_agent_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_statuses(
        agent_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        websocket_connected INTEGER,
        active_chats INTEGER NOT NULL,
        global_running INTEGER NOT NULL,
        global_queued INTEGER NOT NULL,
        recent_error TEXT
      );
      CREATE TABLE IF NOT EXISTS client_commands(
        request_id TEXT PRIMARY KEY,
        command_kind TEXT NOT NULL,
        entity_ref TEXT NOT NULL,
        response_status INTEGER,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_client_commands_created
        ON client_commands(created_at);
      CREATE TABLE IF NOT EXISTS transcript_blocks(
        session_ref TEXT NOT NULL REFERENCES session_refs(session_ref) ON DELETE CASCADE,
        block_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        origin TEXT NOT NULL,
        state TEXT NOT NULL,
        plain_text TEXT NOT NULL,
        block_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_ref, block_id),
        UNIQUE(session_ref, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_blocks_page
        ON transcript_blocks(session_ref, sequence DESC);
      CREATE TABLE IF NOT EXISTS client_events(
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_ref TEXT,
        revision INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_client_events_created
        ON client_events(created_at);
    `);
  }

  private async migrateSchema(): Promise<void> {
    const db = await this.requireDb();
    const columns = await db.all<{ name: string }[]>("PRAGMA table_info(runtime_sessions)");
    if (!columns.some((column) => column.name === "has_messages"))
      await db.exec("ALTER TABLE runtime_sessions ADD COLUMN has_messages INTEGER NOT NULL DEFAULT 0");
    const messageColumns = await db.all<{ name: string }[]>("PRAGMA table_info(clawchat_messages)");
    if (!messageColumns.some((column) => column.name === "rejected_at"))
      await db.exec("ALTER TABLE clawchat_messages ADD COLUMN rejected_at INTEGER");
    if (!messageColumns.some((column) => column.name === "handled_content_json"))
      await db.exec("ALTER TABLE clawchat_messages ADD COLUMN handled_content_json TEXT");
    if (!messageColumns.some((column) => column.name === "handled_at"))
      await db.exec("ALTER TABLE clawchat_messages ADD COLUMN handled_at INTEGER");
    await db.run(
      `UPDATE runtime_sessions AS rs SET has_messages = 1 WHERE has_messages = 0 AND (runtime_session_id IS NOT NULL OR EXISTS (SELECT 1 FROM clawchat_messages AS message WHERE message.local_agent_id = rs.agent_id AND message.chat_id = rs.chat_id AND message.direction = 'inbound' AND message.kind = 'message' AND COALESCE(message.text, '') NOT LIKE '/%' AND message.created_at >= rs.created_at AND NOT EXISTS (SELECT 1 FROM runtime_sessions AS newer WHERE newer.chat_id = rs.chat_id AND newer.agent_id = rs.agent_id AND newer.created_at > rs.created_at AND newer.created_at <= message.created_at)))`,
    );
    const now = Date.now();
    await db.run(
      `INSERT INTO session_intents(chat_id, agent_id, project_id, name, mode, created_at, updated_at) SELECT chat_id, agent_id, project_id, name, mode, ?, ? FROM runtime_sessions WHERE is_current = 1 AND has_messages = 0 ON CONFLICT(chat_id, agent_id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, mode = excluded.mode, updated_at = excluded.updated_at`,
      now,
      now,
    );
    await db.run(
      `DELETE FROM session_refs WHERE runtime_session_id IS NULL AND EXISTS (SELECT 1 FROM runtime_sessions AS session WHERE session.chat_id = session_refs.chat_id AND session.agent_id = session_refs.agent_id AND session.session_id = session_refs.session_id AND session.has_messages = 0)`,
    );
    await db.run("DELETE FROM runtime_sessions WHERE has_messages = 0 AND runtime_session_id IS NULL");
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
function protocolDeliveryContentJson(value: unknown): string {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return toJson(parsed) ?? "null";
  const content = { ...(parsed as Record<string, unknown>) };
  for (const field of ["dseq", "emitted_at", "trace_id"]) delete content[field];
  return toJson(content) ?? "null";
}
function parseJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(stringValue(value)) as unknown;
  } catch {
    return null;
  }
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
function requireStateString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
function nullableString(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}
function sameTranscriptPayload(stored: TranscriptBlock, input: TranscriptBlockInput): boolean {
  const storedPayload = { ...stored } as Record<string, unknown>;
  const inputPayload = { ...input } as Record<string, unknown>;
  for (const key of ["sequence", "revision", "createdAt", "updatedAt"]) {
    delete storedPayload[key];
    delete inputPayload[key];
  }
  return JSON.stringify(storedPayload) === JSON.stringify(inputPayload);
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
    hasMessages: Boolean(row.has_messages),
    isCurrent: Boolean(row.is_current),
    updatedAt: numberValue(row.updated_at),
  };
}

function sessionIntentFromRow(row: Record<string, unknown>): SessionIntentRecord {
  return {
    chatId: stringValue(row.chat_id),
    agentId: stringValue(row.agent_id),
    projectId: nullableString(row.project_id),
    name: nullableString(row.name),
    mode: nullableString(row.mode),
    updatedAt: numberValue(row.updated_at),
  };
}

interface SessionRefRow {
  session_ref: string;
  chat_id: string;
  agent_id: string;
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
