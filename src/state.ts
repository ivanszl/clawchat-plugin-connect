import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ClientViewEvent, RuntimeInteractionBlock, TranscriptBlock } from "./client-contract";
import { defaultStateDbPath } from "./config";
import {
  type ActivationCredentials,
  type LivewareExposureRecord,
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

export type GroupReplyMode = "all" | "mention";

export interface GroupSettingsRecord {
  conversationId: string;
  muted: boolean;
  replyMode: GroupReplyMode;
  batchDelaySeconds: number;
  version: number;
}

export interface GroupSettingsSnapshotRecord {
  authoritative: boolean;
  stale: boolean;
  rows: GroupSettingsRecord[];
}

export type InboundHandlingOutcome = "runtime" | "mention-context" | "muted" | "oversized" | "policy-discarded";

export interface HandledInboundMessage {
  messageId: string;
  raw: unknown;
}

export type ToolRequestState = "pending" | "running" | "succeeded" | "failed" | "expired" | "indeterminate";
export interface ToolRequestRecord {
  requestId: string;
  bindingId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolRequestState;
  result: unknown;
  error: string | null;
  resultTruncated: boolean;
  errorTruncated: boolean;
  sessionRef: string | null;
  turnId: string | null;
  origin: string | null;
  createdAt: number;
  claimedAt: number | null;
  settledAt: number | null;
  expiresAt: number;
  attemptCount: number;
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
      get: <Row>(sql: string, ...bindings: SQLQueryBindings[]) => Row | null,
    ) => T,
  ): T {
    return this.database.transaction(() =>
      callback(
        (sql, ...bindings) => this.database.query<unknown, SQLQueryBindings[]>(sql).run(...bindings),
        <Row>(sql: string, ...bindings: SQLQueryBindings[]) =>
          this.database.query<Row, SQLQueryBindings[]>(sql).get(...bindings),
      ),
    )();
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

type SqliteDb = BunSqliteAdapter;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

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
  model?: string | null;
  reasoningEffort?: string | null;
  sessionOptions?: Record<string, string>;
  hasMessages?: boolean;
  isCurrent?: boolean;
}
export interface AdoptRuntimeThreadRefInput {
  sessionRef: string;
  chatId: string;
  sessionId: string;
  agentId: string;
  projectId: string | null;
  name?: string | null;
  mode?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  sessionOptions?: Record<string, string>;
}
export interface SetSessionIntentInput {
  chatId: string;
  agentId: string;
  projectId: string | null;
  name?: string | null;
  mode?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  sessionOptions?: Record<string, string>;
}

export interface ResolveOrMaterializeRuntimeSessionInput {
  chatId: string;
  agentId: string;
  sessionId: string;
}

export type SessionLifecycleAction = "archive" | "restore" | "delete";
export type SessionLifecycleOperationState = "intent" | "native-confirmed" | "complete";

export interface SessionLifecycleOperationRecord {
  operationId: string;
  sessionRef: string;
  action: SessionLifecycleAction;
  bindingId: string;
  runtimeThreadId: string;
  state: SessionLifecycleOperationState;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeWorkspaceMappingRecord {
  bindingId: string;
  runtimeKind: string;
  identityKey: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
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

export type ClientCommandOutcome =
  | { state: "missing" }
  | { state: "pending"; commandKind: string; entityRef: string }
  | {
      state: "complete";
      commandKind: string;
      entityRef: string;
      responseStatus: number;
      responseBody: unknown;
    };

export type TranscriptBlockInput<T extends TranscriptBlock = TranscriptBlock> = T extends TranscriptBlock
  ? Omit<T, "sequence" | "revision" | "createdAt" | "updatedAt"> & {
      id: string;
      sequence?: number;
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
      await this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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

  async listActivations(): Promise<ActivationCredentials[]> {
    const db = await this.requireDb();
    const rows = await db.all<Array<Record<string, unknown>>>(
      `SELECT local_agent_id, access_token, refresh_token, server_agent_id, user_id, owner_user_id, conversation_id
         FROM activations
        WHERE platform = ?
        ORDER BY local_agent_id`,
      PLATFORM_ID,
    );
    return rows.flatMap((row) => {
      const localAgentId = stringValue(row.local_agent_id);
      const accessToken = stringValue(row.access_token);
      const userId = stringValue(row.user_id);
      const ownerUserId = stringValue(row.owner_user_id);
      if (!localAgentId || !accessToken || !userId || !ownerUserId) return [];
      return [
        {
          localAgentId,
          accessToken,
          refreshToken: nullableString(row.refresh_token),
          serverAgentId: nullableString(row.server_agent_id),
          userId,
          ownerUserId,
          conversationId: nullableString(row.conversation_id),
        },
      ];
    });
  }

  async purgeAgentBinding(localAgentId: string): Promise<void> {
    const bindingId = requireStateString(localAgentId, "Agent Binding ID");
    const db = await this.requireDb();
    db.transaction((run) => {
      run(
        `DELETE FROM turn_submission_cancellations
          WHERE session_ref IN (SELECT session_ref FROM session_refs WHERE agent_id = ?)`,
        bindingId,
      );
      run(
        `DELETE FROM transcript_blocks
          WHERE session_ref IN (SELECT session_ref FROM session_refs WHERE agent_id = ?)`,
        bindingId,
      );
      run(
        `DELETE FROM session_lifecycle_operations
          WHERE binding_id = ?
             OR session_ref IN (SELECT session_ref FROM session_refs WHERE agent_id = ?)`,
        bindingId,
        bindingId,
      );
      run(
        `DELETE FROM client_commands
          WHERE entity_ref = ?
             OR EXISTS (
               SELECT 1
                 FROM session_refs
                WHERE agent_id = ?
                  AND (
                    client_commands.entity_ref = session_refs.session_ref
                    OR client_commands.entity_ref LIKE session_refs.session_ref || ':%'
                  )
             )`,
        bindingId,
        bindingId,
      );
      run(
        `DELETE FROM client_events
          WHERE event_type = 'catalog.changed'
             OR entity_ref IN (SELECT session_ref FROM session_refs WHERE agent_id = ?)`,
        bindingId,
      );
      run("DELETE FROM tool_requests WHERE binding_id = ?", bindingId);
      run("DELETE FROM runtime_workspace_mappings WHERE binding_id = ?", bindingId);
      run("DELETE FROM output_visibility WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM group_settings WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM group_settings_snapshots WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM runtime_sessions WHERE agent_id = ?", bindingId);
      run("DELETE FROM session_intents WHERE agent_id = ?", bindingId);
      run("DELETE FROM session_refs WHERE agent_id = ?", bindingId);
      run("DELETE FROM clawchat_messages WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM protocol_delivery_state WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM protocol_inbox WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM protocol_delivery_quarantine WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM protocol_event_dedup WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM runtime_statuses WHERE agent_id = ?", bindingId);
      run("DELETE FROM liveware_exposures WHERE local_agent_id = ?", bindingId);
      run("DELETE FROM activations WHERE platform = ? AND local_agent_id = ?", PLATFORM_ID, bindingId);
    });
  }

  async getLivewareExposure(localAgentId: string): Promise<LivewareExposureRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      `SELECT owner_user_id, local_agent_id, app_id, public_url, access_policy
         FROM liveware_exposures
        WHERE local_agent_id = ?`,
      localAgentId,
    );
    return row ? livewareExposureFromRow(row) : null;
  }

  async replaceGroupSettingsSnapshot(localAgentId: string, rows: readonly GroupSettingsRecord[]): Promise<void> {
    const bindingId = requireStateString(localAgentId, "Agent Binding ID");
    const normalizedRows = rows.map(normalizeGroupSettingsRecord);
    const db = await this.requireDb();
    const now = Date.now();
    db.transaction((run) => {
      run("DELETE FROM group_settings WHERE local_agent_id = ?", bindingId);
      for (const row of normalizedRows) {
        run(
          `INSERT INTO group_settings(
             local_agent_id, conversation_id, muted, reply_mode, batch_delay_seconds, version, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          bindingId,
          row.conversationId,
          row.muted ? 1 : 0,
          row.replyMode,
          row.batchDelaySeconds,
          row.version,
          now,
        );
      }
      run(
        `INSERT INTO group_settings_snapshots(local_agent_id, authoritative, stale, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(local_agent_id) DO UPDATE SET authoritative = 1, stale = 0, updated_at = excluded.updated_at`,
        bindingId,
        now,
      );
    });
  }

  async markGroupSettingsSnapshotStale(localAgentId: string): Promise<void> {
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO group_settings_snapshots(local_agent_id, authoritative, stale, updated_at)
       VALUES (?, 0, 1, ?)
       ON CONFLICT(local_agent_id) DO UPDATE SET stale = 1, updated_at = excluded.updated_at`,
      requireStateString(localAgentId, "Agent Binding ID"),
      Date.now(),
    );
  }

  async getGroupSettingsSnapshot(localAgentId: string): Promise<GroupSettingsSnapshotRecord> {
    const bindingId = requireStateString(localAgentId, "Agent Binding ID");
    const db = await this.requireDb();
    const metadata = await db.get<Record<string, unknown>>(
      "SELECT authoritative, stale FROM group_settings_snapshots WHERE local_agent_id = ?",
      bindingId,
    );
    const rows = await db.all<Array<Record<string, unknown>>>(
      `SELECT conversation_id, muted, reply_mode, batch_delay_seconds, version
       FROM group_settings WHERE local_agent_id = ? ORDER BY conversation_id`,
      bindingId,
    );
    return {
      authoritative: Number(metadata?.authoritative ?? 0) === 1,
      stale: Number(metadata?.stale ?? 0) === 1,
      rows: rows.map(groupSettingsRecordFromRow),
    };
  }

  async listLivewareExposures(): Promise<LivewareExposureRecord[]> {
    const db = await this.requireDb();
    const rows = await db.all<Array<Record<string, unknown>>>(
      `SELECT owner_user_id, local_agent_id, app_id, public_url, access_policy
         FROM liveware_exposures
        ORDER BY local_agent_id`,
    );
    return rows.flatMap((row) => {
      const exposure = livewareExposureFromRow(row);
      return exposure ? [exposure] : [];
    });
  }

  async setLivewareExposure(record: LivewareExposureRecord): Promise<void> {
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO liveware_exposures(
         owner_user_id, local_agent_id, app_id, public_url, access_policy, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(local_agent_id) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         app_id = excluded.app_id,
         public_url = excluded.public_url,
         access_policy = excluded.access_policy,
         updated_at = excluded.updated_at`,
      record.ownerUserId,
      record.localAgentId,
      record.appId,
      record.publicUrl,
      record.accessPolicy,
      Date.now(),
    );
  }

  async clearLivewareExposure(localAgentId: string): Promise<void> {
    const db = await this.requireDb();
    await db.run("DELETE FROM liveware_exposures WHERE local_agent_id = ?", localAgentId);
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
  async getOutputVisibility(localAgentId: string, chatId: string): Promise<OutputVisibility | null> {
    const db = await this.requireDb();
    const row = await db.get<{ mode?: string }>(
      "SELECT mode FROM output_visibility WHERE local_agent_id = ? AND chat_id = ?",
      requireStateString(localAgentId, "Agent Binding ID"),
      requireStateString(chatId, "chatId"),
    );
    return row?.mode === "minimal" || row?.mode === "normal" || row?.mode === "full" ? row.mode : null;
  }
  async setOutputVisibility(localAgentId: string, chatId: string, mode: OutputVisibility): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    await db.run(
      `INSERT INTO output_visibility(local_agent_id, chat_id, mode, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(local_agent_id, chat_id)
       DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      requireStateString(localAgentId, "Agent Binding ID"),
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
  async deleteRuntimeWorkspaceMappingsForProject(projectId: string): Promise<void> {
    const db = await this.requireDb();
    await db.run(`DELETE FROM runtime_workspace_mappings WHERE project_id = ?`, projectId);
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
      `INSERT INTO runtime_sessions(chat_id, session_id, agent_id, runtime_session_id, project_id, name, mode, model, reasoning_effort, session_options_json, has_messages, is_current, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, agent_id, session_id) DO UPDATE SET agent_id = excluded.agent_id, runtime_session_id = excluded.runtime_session_id, project_id = excluded.project_id, name = excluded.name, mode = excluded.mode, model = excluded.model, reasoning_effort = excluded.reasoning_effort, session_options_json = excluded.session_options_json, has_messages = CASE WHEN runtime_sessions.has_messages = 1 OR excluded.has_messages = 1 THEN 1 ELSE 0 END, is_current = excluded.is_current, updated_at = excluded.updated_at`,
      input.chatId,
      input.sessionId,
      input.agentId,
      input.runtimeSessionId ?? null,
      input.projectId ?? null,
      input.name ?? null,
      input.mode ?? null,
      input.model ?? null,
      input.reasoningEffort ?? null,
      JSON.stringify(input.sessionOptions ?? {}),
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

  async adoptRuntimeThreadRef(input: AdoptRuntimeThreadRefInput): Promise<RuntimeSessionRecord | null> {
    const db = await this.requireDb();
    const now = Date.now();
    db.transaction((run, get) => {
      const target = get<SessionRefRow>(
        "SELECT * FROM session_refs WHERE session_ref = ? COLLATE NOCASE",
        input.sessionRef,
      );
      if (!target || target.agent_id !== input.agentId || !target.runtime_session_id || target.session_id) return;
      const attached = get<{ session_id: string }>(
        "SELECT session_id FROM runtime_sessions WHERE agent_id = ? AND runtime_session_id = ? LIMIT 1",
        input.agentId,
        target.runtime_session_id,
      );
      if (attached) throw new Error(`Runtime Thread is already attached to Session ${attached.session_id}`);
      const competingRef = get<SessionRefRow>(
        "SELECT * FROM session_refs WHERE chat_id = ? AND agent_id = ? AND runtime_session_id = ?",
        input.chatId,
        input.agentId,
        target.runtime_session_id,
      );
      if (competingRef && competingRef.session_ref !== target.session_ref) {
        if (competingRef.session_id)
          throw new Error(`Runtime Thread is already mapped to Session Ref ${competingRef.session_ref}`);
        run("DELETE FROM session_refs WHERE session_ref = ?", competingRef.session_ref);
      }
      run("UPDATE runtime_sessions SET is_current = 0 WHERE chat_id = ? AND agent_id = ?", input.chatId, input.agentId);
      run("DELETE FROM session_intents WHERE chat_id = ? AND agent_id = ?", input.chatId, input.agentId);
      run(
        `INSERT INTO runtime_sessions(chat_id, session_id, agent_id, runtime_session_id, project_id, name, mode, model, reasoning_effort, session_options_json, has_messages, is_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        input.chatId,
        input.sessionId,
        input.agentId,
        target.runtime_session_id,
        input.projectId,
        input.name ?? null,
        input.mode ?? null,
        input.model ?? null,
        input.reasoningEffort ?? null,
        JSON.stringify(input.sessionOptions ?? {}),
        now,
        now,
      );
      const moved = run(
        `UPDATE session_refs
         SET chat_id = ?, session_id = ?, updated_at = ?
         WHERE session_ref = ? COLLATE NOCASE AND session_id IS NULL`,
        input.chatId,
        input.sessionId,
        now,
        target.session_ref,
      );
      if (moved.changes !== 1) throw new Error(`Session Ref ${input.sessionRef} could not be adopted`);
    });
    return await this.getRuntimeSessionByRef(input.sessionRef);
  }

  async setRuntimeSessionModelSelection(
    chatId: string,
    agentId: string,
    sessionId: string,
    model: string | null,
    reasoningEffort: string | null,
  ): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      "UPDATE runtime_sessions SET model = ?, reasoning_effort = ?, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
      model,
      reasoningEffort,
      Date.now(),
      chatId,
      agentId,
      sessionId,
    );
    return result.changes > 0;
  }

  async setRuntimeSessionOptions(
    chatId: string,
    agentId: string,
    sessionId: string,
    sessionOptions: Record<string, string>,
  ): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      "UPDATE runtime_sessions SET session_options_json = ?, updated_at = ? WHERE chat_id = ? AND agent_id = ? AND session_id = ?",
      JSON.stringify(sessionOptions),
      Date.now(),
      chatId,
      agentId,
      sessionId,
    );
    return result.changes > 0;
  }

  async setSessionIntent(input: SetSessionIntentInput): Promise<void> {
    const now = Date.now();
    const db = await this.requireDb();
    db.transaction((run) => {
      run("UPDATE runtime_sessions SET is_current = 0 WHERE chat_id = ? AND agent_id = ?", input.chatId, input.agentId);
      run(
        `INSERT INTO session_intents(chat_id, agent_id, project_id, name, mode, model, reasoning_effort, session_options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, agent_id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, mode = excluded.mode, model = excluded.model, reasoning_effort = excluded.reasoning_effort, session_options_json = excluded.session_options_json, updated_at = excluded.updated_at`,
        input.chatId,
        input.agentId,
        input.projectId,
        input.name ?? null,
        input.mode ?? null,
        input.model ?? null,
        input.reasoningEffort ?? null,
        JSON.stringify(input.sessionOptions ?? {}),
        now,
        now,
      );
    });
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

  async resolveOrMaterializeRuntimeSession(
    input: ResolveOrMaterializeRuntimeSessionInput,
  ): Promise<RuntimeSessionRecord> {
    const db = await this.requireDb();
    const now = Date.now();
    const sessionId = db.transaction((run, get) => {
      const current = get<{ session_id: string }>(
        "SELECT session_id FROM runtime_sessions WHERE chat_id = ? AND agent_id = ? AND is_current = 1 ORDER BY updated_at DESC LIMIT 1",
        input.chatId,
        input.agentId,
      );
      if (current?.session_id) return current.session_id;
      const intent = get<Record<string, unknown>>(
        "SELECT * FROM session_intents WHERE chat_id = ? AND agent_id = ?",
        input.chatId,
        input.agentId,
      );
      run(
        `INSERT INTO runtime_sessions(chat_id, session_id, agent_id, runtime_session_id, project_id, name, mode, model, reasoning_effort, session_options_json, has_messages, is_current, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        input.chatId,
        input.sessionId,
        input.agentId,
        nullableString(intent?.project_id),
        nullableString(intent?.name),
        nullableString(intent?.mode),
        nullableString(intent?.model),
        nullableString(intent?.reasoning_effort),
        JSON.stringify(stringRecordFromJson(intent?.session_options_json)),
        now,
        now,
      );
      run("DELETE FROM session_intents WHERE chat_id = ? AND agent_id = ?", input.chatId, input.agentId);
      return input.sessionId;
    });
    await this.getOrCreateSessionRef({ chatId: input.chatId, agentId: input.agentId, sessionId });
    const session = await this.getCurrentRuntimeSession(input.chatId, input.agentId);
    if (!session || session.sessionId !== sessionId) throw new Error("failed to materialize current Session");
    return session;
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

  async createSessionLifecycleOperation(input: {
    operationId: string;
    sessionRef: string;
    action: SessionLifecycleAction;
    bindingId: string;
    runtimeThreadId: string;
  }): Promise<SessionLifecycleOperationRecord> {
    const db = await this.requireDb();
    const now = Date.now();
    await db.run(
      `INSERT INTO session_lifecycle_operations(
        operation_id, session_ref, action, binding_id, runtime_thread_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)`,
      input.operationId,
      input.sessionRef.toUpperCase(),
      input.action,
      input.bindingId,
      input.runtimeThreadId,
      now,
      now,
    );
    return {
      ...input,
      sessionRef: input.sessionRef.toUpperCase(),
      state: "intent",
      createdAt: now,
      updatedAt: now,
    };
  }

  async setSessionLifecycleOperationState(
    operationId: string,
    state: SessionLifecycleOperationState,
  ): Promise<boolean> {
    const db = await this.requireDb();
    const result = await db.run(
      "UPDATE session_lifecycle_operations SET state = ?, updated_at = ? WHERE operation_id = ?",
      state,
      Date.now(),
      operationId,
    );
    return result.changes > 0;
  }

  async listIncompleteSessionLifecycleOperations(): Promise<SessionLifecycleOperationRecord[]> {
    const db = await this.requireDb();
    const rows = await db.all<Record<string, unknown>[]>(
      "SELECT * FROM session_lifecycle_operations WHERE state != 'complete' ORDER BY created_at ASC",
    );
    return rows.map(sessionLifecycleOperationFromRow);
  }

  async mapRuntimeWorkspaceIdentity(input: {
    bindingId: string;
    runtimeKind: string;
    identityKey: string;
    projectId: string;
  }): Promise<RuntimeWorkspaceMappingRecord> {
    const db = await this.requireDb();
    const now = Date.now();
    const existing = await this.getRuntimeWorkspaceMapping(input.bindingId, input.runtimeKind, input.identityKey);
    if (existing && existing.projectId !== input.projectId) {
      throw new Error(
        `Runtime Workspace Identity ${input.identityKey} is already mapped to Project ${existing.projectId}`,
      );
    }
    await db.run(
      `INSERT INTO runtime_workspace_mappings(
        binding_id, runtime_kind, identity_key, project_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_id, runtime_kind, identity_key)
      DO UPDATE SET updated_at = excluded.updated_at`,
      input.bindingId,
      input.runtimeKind,
      input.identityKey,
      input.projectId,
      now,
      now,
    );
    return { ...input, createdAt: now, updatedAt: now };
  }

  async getRuntimeWorkspaceMapping(
    bindingId: string,
    runtimeKind: string,
    identityKey: string,
  ): Promise<RuntimeWorkspaceMappingRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>(
      `SELECT * FROM runtime_workspace_mappings
       WHERE binding_id = ? AND runtime_kind = ? AND identity_key = ?`,
      bindingId,
      runtimeKind,
      identityKey,
    );
    return row
      ? {
          bindingId: stringValue(row.binding_id),
          runtimeKind: stringValue(row.runtime_kind),
          identityKey: stringValue(row.identity_key),
          projectId: stringValue(row.project_id),
          createdAt: numberValue(row.created_at),
          updatedAt: numberValue(row.updated_at),
        }
      : null;
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
           handled_content_json = NULL, handled_at = NULL, handling_outcome = NULL
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
  async markInboundMessageHandled(
    agentId: string,
    messageId: string,
    raw: unknown,
    outcome: InboundHandlingOutcome = "runtime",
  ): Promise<void> {
    await this.markInboundMessagesHandled(agentId, [{ messageId, raw }], outcome);
  }
  async markInboundMessagesHandled(
    agentId: string,
    messages: readonly HandledInboundMessage[],
    outcome: InboundHandlingOutcome = "runtime",
  ): Promise<void> {
    if (messages.length === 0) return;
    const db = await this.requireDb();
    const normalizedAgentId = requireStateString(agentId, "agentId");
    const handledAt = Date.now();
    db.transaction((run, get) => {
      for (const message of messages) {
        const normalizedMessageId = requireStateString(message.messageId, "messageId");
        const current = get<{ raw_json?: string }>(
          `SELECT raw_json FROM clawchat_messages
           WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?`,
          normalizedAgentId,
          normalizedMessageId,
        );
        if (!current) throw new Error(`inbound message was not persisted before handling: ${message.messageId}`);
        if (protocolDeliveryContentJson(current.raw_json) !== protocolDeliveryContentJson(message.raw)) continue;
        run(
          `UPDATE clawchat_messages
           SET handled_content_json = ?, handled_at = ?, handling_outcome = ?
           WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?
             AND raw_json = ?`,
          protocolDeliveryContentJson(message.raw),
          handledAt,
          outcome,
          normalizedAgentId,
          normalizedMessageId,
          current.raw_json ?? null,
        );
        // A concurrent coalesced update deliberately wins. Its own handler will
        // write the completion marker for the newer content.
      }
    });
  }
  async listRecentGroupContext(
    agentId: string,
    chatId: string,
    beforeMessageId: string,
    limit = 10,
  ): Promise<unknown[]> {
    const db = await this.requireDb();
    const normalizedAgentId = requireStateString(agentId, "agentId");
    const rows = await db.all<Array<{ raw_json?: string }>>(
      `SELECT raw_json FROM clawchat_messages
       WHERE local_agent_id = ?
         AND direction = 'inbound'
         AND kind = 'message'
         AND chat_id = ?
         AND handling_outcome = 'mention-context'
         AND id < COALESCE((
           SELECT id FROM clawchat_messages
           WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?
         ), 9223372036854775807)
       ORDER BY id DESC LIMIT ?`,
      normalizedAgentId,
      requireStateString(chatId, "chatId"),
      normalizedAgentId,
      requireStateString(beforeMessageId, "beforeMessageId"),
      Math.max(0, Math.min(10, Math.floor(limit))),
    );
    return rows.reverse().map((row) => parseJsonValue(row.raw_json));
  }
  async hasReconciledInboundMessage(agentId: string, messageId: string): Promise<boolean> {
    const db = await this.requireDb();
    const row = await db.get<{ present: number }>(
      `SELECT 1 AS present
       FROM clawchat_messages AS message
       JOIN runtime_sessions AS session
         ON session.chat_id = message.chat_id
        AND session.agent_id = message.local_agent_id
       JOIN session_refs AS ref
         ON ref.chat_id = session.chat_id
        AND ref.agent_id = session.agent_id
        AND ref.session_id = session.session_id
       JOIN transcript_blocks AS block
         ON block.session_ref = ref.session_ref
       WHERE message.local_agent_id = ?
         AND message.direction = 'inbound'
         AND message.kind = 'message'
         AND message.message_id = ?
         AND block.origin = 'clawchat'
         AND substr(block.block_id, 1, 2) = 'b_'
         AND block.plain_text = COALESCE(message.text, '')
         AND ABS(block.created_at - message.created_at) <= 10000
       LIMIT 1`,
      requireStateString(agentId, "agentId"),
      requireStateString(messageId, "messageId"),
    );
    return row?.present === 1;
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
    await db.run("DELETE FROM turn_submission_cancellations WHERE created_at < ?", now - 24 * 60 * 60 * 1_000);
  }

  async cancelTurnSubmission(submissionId: string, sessionRef: string): Promise<boolean> {
    const db = await this.requireDb();
    await db.run(
      "INSERT OR IGNORE INTO turn_submission_cancellations(submission_id, session_ref, created_at) VALUES (?, ?, ?)",
      submissionId,
      sessionRef,
      Date.now(),
    );
    const row = await db.get<{ session_ref: string }>(
      "SELECT session_ref FROM turn_submission_cancellations WHERE submission_id = ?",
      submissionId,
    );
    return row?.session_ref === sessionRef;
  }

  async isTurnSubmissionCancelled(submissionId: string, sessionRef: string): Promise<boolean> {
    const db = await this.requireDb();
    const row = await db.get<{ present: number }>(
      "SELECT 1 AS present FROM turn_submission_cancellations WHERE submission_id = ? AND session_ref = ?",
      submissionId,
      sessionRef,
    );
    return row?.present === 1;
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

  async getClientCommandOutcome(requestId: string): Promise<ClientCommandOutcome> {
    const db = await this.requireDb();
    const row = await db.get<{
      command_kind: string;
      entity_ref: string;
      response_status: number | null;
      response_json: string | null;
    }>(
      "SELECT command_kind, entity_ref, response_status, response_json FROM client_commands WHERE request_id = ?",
      requestId,
    );
    if (!row) return { state: "missing" };
    if (row.response_status == null || row.response_json == null) {
      return { state: "pending", commandKind: row.command_kind, entityRef: row.entity_ref };
    }
    try {
      return {
        state: "complete",
        commandKind: row.command_kind,
        entityRef: row.entity_ref,
        responseStatus: row.response_status,
        responseBody: JSON.parse(row.response_json),
      };
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
    return db.transaction((run, get) => {
      const existing = get<{ sequence: number; revision: number; created_at: number; block_json: string }>(
        "SELECT sequence, revision, created_at, block_json FROM transcript_blocks WHERE session_ref = ? AND block_id = ?",
        sessionRef,
        input.id,
      );
      let storedBlock: TranscriptBlock | null = null;
      if (existing) {
        try {
          storedBlock = JSON.parse(existing.block_json) as TranscriptBlock;
        } catch {
          // Replace malformed projection JSON below.
        }
      }
      const projectedInput = preserveConnectOwnedMessageMetadata(storedBlock, input);
      const keepsExistingSequence =
        projectedInput.sequence === undefined || projectedInput.sequence === existing?.sequence;
      if (storedBlock && keepsExistingSequence && sameTranscriptPayload(storedBlock, projectedInput)) {
        return { block: storedBlock, cursor: 0 };
      }
      const now = Date.now();
      if (projectedInput.sequence !== undefined) {
        const occupant = get<{
          block_id: string;
          revision: number;
          block_json: string;
        }>(
          "SELECT block_id, revision, block_json FROM transcript_blocks WHERE session_ref = ? AND sequence = ?",
          sessionRef,
          projectedInput.sequence,
        );
        if (occupant && occupant.block_id !== projectedInput.id) {
          const nextSequence = numberValue(
            get<{ sequence?: number }>(
              "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM transcript_blocks WHERE session_ref = ?",
              sessionRef,
            )?.sequence,
          );
          const previous = JSON.parse(occupant.block_json) as TranscriptBlock;
          const relocated: TranscriptBlock = {
            ...previous,
            revision: occupant.revision + 1,
            sequence: nextSequence,
            updatedAt: new Date(now).toISOString(),
          };
          run(
            "UPDATE transcript_blocks SET revision = ?, sequence = ?, block_json = ?, updated_at = ? WHERE session_ref = ? AND block_id = ?",
            relocated.revision,
            relocated.sequence,
            JSON.stringify(relocated),
            now,
            sessionRef,
            occupant.block_id,
          );
          const relocatedEvent = {
            type: "transcript.block-upserted",
            cursor: 0,
            sessionRef,
            revision: relocated.revision,
            block: relocated,
          } satisfies ClientViewEvent;
          run(
            "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
            relocatedEvent.type,
            sessionRef,
            relocated.revision,
            JSON.stringify(relocatedEvent),
            now,
          );
        }
      }
      const sequence =
        projectedInput.sequence ??
        existing?.sequence ??
        numberValue(
          get<{ sequence?: number }>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM transcript_blocks WHERE session_ref = ?",
            sessionRef,
          )?.sequence,
        );
      const revision = Math.max(
        projectedInput.revision ?? (existing?.revision ?? 0) + 1,
        (existing?.revision ?? 0) + 1,
      );
      const createdAt = projectedInput.createdAt ? Date.parse(projectedInput.createdAt) : (existing?.created_at ?? now);
      const updatedAt = projectedInput.updatedAt ? Date.parse(projectedInput.updatedAt) : now;
      const block = {
        ...projectedInput,
        revision,
        sequence,
        createdAt: new Date(Number.isFinite(createdAt) ? createdAt : now).toISOString(),
        updatedAt: new Date(Number.isFinite(updatedAt) ? updatedAt : now).toISOString(),
      } as TranscriptBlock;
      run(
        `INSERT INTO transcript_blocks(session_ref, block_id, revision, sequence, block_type, origin, state, plain_text, block_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_ref, block_id) DO UPDATE SET revision = excluded.revision, sequence = excluded.sequence, block_type = excluded.block_type, origin = excluded.origin, state = excluded.state, plain_text = excluded.plain_text, block_json = excluded.block_json, updated_at = excluded.updated_at`,
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
      const eventInsert = run(
        "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
        eventWithoutCursor.type,
        sessionRef,
        block.revision,
        JSON.stringify(eventWithoutCursor),
        now,
      );
      return { block, cursor: Number(eventInsert.lastInsertRowid) };
    });
  }

  async countTranscriptBlocks(sessionRef: string): Promise<number> {
    const db = await this.requireDb();
    const row = await db.get<{ count?: number }>(
      "SELECT COUNT(*) AS count FROM transcript_blocks WHERE session_ref = ?",
      sessionRef,
    );
    return numberValue(row?.count);
  }

  async updateTranscriptSenderDisplayName(senderId: string, displayName: string): Promise<number> {
    const db = await this.requireDb();
    const normalizedSenderId = requireStateString(senderId, "senderId");
    const normalizedDisplayName = requireStateString(displayName, "displayName");
    const rows = await db.all<Array<{ session_ref: string; block_json: string }>>(
      `SELECT session_ref, block_json
         FROM transcript_blocks
        WHERE block_type = 'message'
          AND json_extract(block_json, '$.sender.id') = ?
          AND (
            json_extract(block_json, '$.sender.displayName') IS NULL
            OR json_extract(block_json, '$.sender.displayName') = ?
          )`,
      normalizedSenderId,
      normalizedSenderId,
    );
    let updated = 0;
    for (const row of rows) {
      let block: TranscriptBlock;
      try {
        block = JSON.parse(row.block_json) as TranscriptBlock;
      } catch {
        continue;
      }
      if (block.type !== "message" || block.sender?.id !== normalizedSenderId) continue;
      await this.upsertTranscriptBlock(row.session_ref, {
        ...block,
        author: normalizedDisplayName,
        sender: { ...block.sender, displayName: normalizedDisplayName },
      });
      updated += 1;
    }
    return updated;
  }

  async listPendingRuntimeInteractions(sessionRef: string): Promise<RuntimeInteractionBlock[]> {
    const db = await this.requireDb();
    const rows = await db.all<{ block_json: string }[]>(
      "SELECT block_json FROM transcript_blocks WHERE session_ref = ? AND block_type = 'runtime-interaction' AND state = 'pending' ORDER BY sequence ASC",
      sessionRef,
    );
    return rows.flatMap((row) => {
      try {
        const block = JSON.parse(row.block_json) as TranscriptBlock;
        return block.type === "runtime-interaction" && block.responseState === "pending" ? [block] : [];
      } catch {
        return [];
      }
    });
  }

  async expirePendingRuntimeInteractions(reason = "Connect restarted"): Promise<number> {
    const db = await this.requireDb();
    const rows = await db.all<{ session_ref: string; block_json: string }[]>(
      "SELECT session_ref, block_json FROM transcript_blocks WHERE block_type = 'runtime-interaction' AND state = 'pending'",
    );
    let expired = 0;
    for (const row of rows) {
      let block: TranscriptBlock;
      try {
        block = JSON.parse(row.block_json) as TranscriptBlock;
      } catch {
        continue;
      }
      if (block.type !== "runtime-interaction" || block.responseState !== "pending") continue;
      await this.upsertTranscriptBlock(row.session_ref, {
        ...block,
        state: "cancelled",
        plainText: `${block.title}\n${reason}`,
        description: reason,
        responseState: "expired",
        resolvedBy: "system",
      });
      expired += 1;
    }
    return expired;
  }

  async rekeyTranscriptBlock(
    sessionRef: string,
    previousBlockId: string,
    input: TranscriptBlockInput,
  ): Promise<TranscriptBlock | null> {
    const db = await this.requireDb();
    const candidate = await db.get<{
      block_id: string;
      revision: number;
      sequence: number;
      created_at: number;
      block_json: string;
    }>(
      "SELECT block_id, revision, sequence, created_at, block_json FROM transcript_blocks WHERE session_ref = ? AND block_id = ?",
      sessionRef,
      previousBlockId,
    );
    if (!candidate) return null;
    const stable = await db.get<{
      block_id: string;
      revision: number;
      sequence: number;
      created_at: number;
      block_json: string;
    }>(
      "SELECT block_id, revision, sequence, created_at, block_json FROM transcript_blocks WHERE session_ref = ? AND block_id = ?",
      sessionRef,
      input.id,
    );
    const previous = JSON.parse(candidate.block_json) as TranscriptBlock;
    const now = Date.now();
    const projectedInput = preserveConnectOwnedMessageMetadata(previous, input);
    const block: TranscriptBlock = {
      ...projectedInput,
      revision: Math.max(candidate.revision, stable?.revision ?? 0) + 1,
      sequence: candidate.sequence,
      createdAt: new Date(candidate.created_at).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    const removed = {
      type: "transcript.block-removed",
      cursor: 0,
      sessionRef,
      revision: block.revision,
      blockId: candidate.block_id,
    } satisfies ClientViewEvent;
    const upserted = {
      type: "transcript.block-upserted",
      cursor: 0,
      sessionRef,
      revision: block.revision,
      block,
    } satisfies ClientViewEvent;
    db.transaction((run) => {
      if (stable && stable.block_id !== candidate.block_id) {
        run("DELETE FROM transcript_blocks WHERE session_ref = ? AND block_id = ?", sessionRef, stable.block_id);
      }
      const updated = run(
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
      if (updated.changes !== 1) throw new Error("matching transcript block changed during reconciliation");
      run(
        "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
        removed.type,
        sessionRef,
        removed.revision,
        JSON.stringify(removed),
        now,
      );
      run(
        "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
        upserted.type,
        sessionRef,
        upserted.revision,
        JSON.stringify(upserted),
        now,
      );
    });
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

  async appendClientViewEvent(event: ClientViewEvent): Promise<number> {
    if (event.type !== "catalog.changed" && event.type !== "session.changed") {
      throw new Error(`Client view event ${event.type} must be committed by its owning projection`);
    }
    const db = await this.requireDb();
    const inserted = await db.run(
      "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      event.type,
      event.type === "session.changed" ? event.sessionRef : "catalog",
      event.revision,
      JSON.stringify({ ...event, cursor: 0, previousCursor: undefined }),
      Date.now(),
    );
    return Number(inserted.lastInsertRowid);
  }

  async listClientEvents(afterCursor: number, limit = 500): Promise<StoredClientEvent[]> {
    const db = await this.requireDb();
    const rows = await db.all<
      Array<{ cursor: number; previous_cursor: number | null; event_json: string; created_at: number }>
    >(
      `SELECT current.cursor,
        (SELECT MAX(previous.cursor) FROM client_events AS previous WHERE previous.cursor < current.cursor) AS previous_cursor,
        current.event_json,
        current.created_at
       FROM client_events AS current
       WHERE current.cursor > ?
       ORDER BY current.cursor ASC
       LIMIT ?`,
      afterCursor,
      Math.max(1, Math.min(1_000, Math.trunc(limit))),
    );
    return rows.flatMap((row) => {
      try {
        const event = JSON.parse(row.event_json) as ClientViewEvent;
        return [
          {
            cursor: row.cursor,
            event: {
              ...event,
              cursor: row.cursor,
              previousCursor: row.previous_cursor ?? 0,
            } as ClientViewEvent,
            createdAt: row.created_at,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  async submitToolRequest(input: {
    requestId: string;
    bindingId: string;
    toolName: string;
    normalizedInput: Record<string, unknown>;
    recordedInput?: Record<string, unknown>;
    timeoutMs: number;
    provenance?: { sessionRef?: string; turnId?: string; origin?: string };
  }): Promise<ToolRequestRecord> {
    const db = await this.requireDb();
    const now = Date.now();
    await db.run(
      `INSERT INTO tool_requests(
         request_id, binding_id, tool_name, input_json, record_input_json, state, created_at, expires_at,
         session_ref, turn_id, origin
       )
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO NOTHING`,
      input.requestId,
      input.bindingId,
      input.toolName,
      JSON.stringify(input.normalizedInput),
      JSON.stringify(input.recordedInput ?? input.normalizedInput),
      now,
      now + input.timeoutMs,
      input.provenance?.sessionRef ?? null,
      input.provenance?.turnId ?? null,
      input.provenance?.origin ?? null,
    );
    const record = await this.getToolRequest(input.requestId);
    if (!record) throw new Error(`failed to persist tool request ${input.requestId}`);
    if (record.bindingId !== input.bindingId || record.toolName !== input.toolName)
      throw new Error(`request id ${input.requestId} already belongs to another tool call`);
    return record;
  }

  async getToolRequest(requestId: string): Promise<ToolRequestRecord | null> {
    const db = await this.requireDb();
    const row = await db.get<Record<string, unknown>>("SELECT * FROM tool_requests WHERE request_id = ?", requestId);
    return row ? toolRequestRecord(row) : null;
  }

  async claimNextToolRequest(bindingId: string): Promise<ToolRequestRecord | null> {
    const db = await this.requireDb();
    const now = Date.now();
    return db.transaction((run, get) => {
      run(
        `UPDATE tool_requests SET state = 'expired', error = 'request expired before execution',
         input_json = record_input_json, settled_at = ?
         WHERE binding_id = ? AND state = 'pending' AND expires_at <= ?`,
        now,
        bindingId,
        now,
      );
      const row = get<Record<string, unknown>>(
        `SELECT * FROM tool_requests WHERE binding_id = ? AND state = 'pending' AND expires_at > ?
         ORDER BY created_at ASC LIMIT 1`,
        bindingId,
        now,
      );
      if (!row) return null;
      const updated = run(
        "UPDATE tool_requests SET state = 'running', claimed_at = ?, attempt_count = attempt_count + 1 WHERE request_id = ? AND state = 'pending'",
        now,
        stringValue(row.request_id),
      );
      if (updated.changes !== 1) return null;
      return toolRequestRecord({ ...row, state: "running", claimed_at: now, attempt_count: 1 });
    });
  }

  async settleToolRequest(
    requestId: string,
    outcome: { state: "succeeded"; result: unknown } | { state: "failed" | "indeterminate"; error: string },
  ): Promise<void> {
    const db = await this.requireDb();
    const boundedResult = outcome.state === "succeeded" ? boundedJson(outcome.result) : null;
    const boundedError = outcome.state === "succeeded" ? null : boundedText(outcome.error, 8_192);
    await db.run(
      `UPDATE tool_requests SET state = ?, result_json = ?, error = ?, result_truncated = ?,
       error_truncated = ?, input_json = record_input_json, settled_at = ?
       WHERE request_id = ? AND state = 'running'`,
      outcome.state,
      boundedResult?.value ?? null,
      boundedError?.value ?? null,
      boundedResult?.truncated ? 1 : 0,
      boundedError?.truncated ? 1 : 0,
      Date.now(),
      requestId,
    );
  }

  async expireToolRequest(requestId: string): Promise<ToolRequestRecord | null> {
    const db = await this.requireDb();
    const now = Date.now();
    await db.run(
      `UPDATE tool_requests SET
         state = CASE state WHEN 'pending' THEN 'expired' ELSE 'indeterminate' END,
         error = CASE state
           WHEN 'pending' THEN 'request expired before execution'
           ELSE 'local deadline elapsed after execution began; outcome is indeterminate'
         END,
         input_json = record_input_json,
         settled_at = ?
       WHERE request_id = ? AND state IN ('pending', 'running')`,
      now,
      requestId,
    );
    return await this.getToolRequest(requestId);
  }

  async markInterruptedToolRequestsIndeterminate(bindingId: string): Promise<void> {
    const db = await this.requireDb();
    await db.run(
      `UPDATE tool_requests
       SET state = 'indeterminate',
         error = 'Connect Service stopped after claiming this request; it will not be retried',
         input_json = record_input_json,
         settled_at = ?
       WHERE binding_id = ? AND state = 'running'`,
      Date.now(),
      bindingId,
    );
  }

  async pruneSettledToolRequests(bindingId: string, now = Date.now()): Promise<void> {
    const db = await this.requireDb();
    const cutoff = now - 90 * 24 * 60 * 60 * 1_000;
    await db.run(
      "DELETE FROM tool_requests WHERE binding_id = ? AND settled_at IS NOT NULL AND state != 'indeterminate' AND settled_at < ?",
      bindingId,
      cutoff,
    );
    await db.run(
      `DELETE FROM tool_requests WHERE request_id IN (
         SELECT request_id FROM tool_requests WHERE binding_id = ? AND settled_at IS NOT NULL AND state != 'indeterminate'
         ORDER BY settled_at DESC LIMIT -1 OFFSET 10000
       )`,
      bindingId,
    );
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
      CREATE TABLE IF NOT EXISTS liveware_exposures(
        local_agent_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        app_id TEXT NOT NULL UNIQUE,
        public_url TEXT NOT NULL,
        access_policy TEXT NOT NULL CHECK(access_policy IN ('private', 'public')),
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
        model TEXT,
        reasoning_effort TEXT,
        session_options_json TEXT NOT NULL DEFAULT '{}',
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
        model TEXT,
        reasoning_effort TEXT,
        session_options_json TEXT NOT NULL DEFAULT '{}',
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
      CREATE TABLE IF NOT EXISTS session_lifecycle_operations(
        operation_id TEXT PRIMARY KEY,
        session_ref TEXT NOT NULL COLLATE NOCASE,
        action TEXT NOT NULL CHECK(action IN ('archive', 'restore', 'delete')),
        binding_id TEXT NOT NULL,
        runtime_thread_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('intent', 'native-confirmed', 'complete')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_lifecycle_incomplete
        ON session_lifecycle_operations(state, created_at);
      CREATE TABLE IF NOT EXISTS runtime_workspace_mappings(
        binding_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(binding_id, runtime_kind, identity_key)
      );
      CREATE TABLE IF NOT EXISTS output_visibility(
        local_agent_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(local_agent_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS group_settings_snapshots(
        local_agent_id TEXT PRIMARY KEY,
        authoritative INTEGER NOT NULL CHECK(authoritative IN (0, 1)),
        stale INTEGER NOT NULL CHECK(stale IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_settings(
        local_agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        muted INTEGER NOT NULL CHECK(muted IN (0, 1)),
        reply_mode TEXT NOT NULL CHECK(reply_mode IN ('all', 'mention')),
        batch_delay_seconds INTEGER NOT NULL CHECK(batch_delay_seconds >= 0),
        version INTEGER NOT NULL CHECK(version >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(local_agent_id, conversation_id)
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
        handled_at INTEGER,
        handling_outcome TEXT
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
      CREATE TABLE IF NOT EXISTS tool_requests(
        request_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'succeeded', 'failed', 'expired', 'indeterminate')),
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        settled_at INTEGER,
        expires_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        record_input_json TEXT NOT NULL,
        result_truncated INTEGER NOT NULL DEFAULT 0,
        error_truncated INTEGER NOT NULL DEFAULT 0,
        session_ref TEXT,
        turn_id TEXT,
        origin TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tool_requests_claim
        ON tool_requests(binding_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_requests_retention
        ON tool_requests(binding_id, settled_at);
      CREATE TABLE IF NOT EXISTS turn_submission_cancellations(
        submission_id TEXT PRIMARY KEY,
        session_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_submission_cancellations_created
        ON turn_submission_cancellations(created_at);
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
    const legacyLivewareTable = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'liveware_exposure'",
    );
    if (legacyLivewareTable) {
      await db.exec(
        `INSERT OR IGNORE INTO liveware_exposures(
           owner_user_id, local_agent_id, app_id, public_url, access_policy, updated_at
         )
         SELECT owner_user_id, local_agent_id, app_id, public_url, access_policy, updated_at
           FROM liveware_exposure`,
      );
      await db.exec("DROP TABLE liveware_exposure");
    }
    const outputVisibilityColumns = await db.all<{ name: string }[]>("PRAGMA table_info(output_visibility)");
    if (!outputVisibilityColumns.some((column) => column.name === "local_agent_id")) {
      await db.exec(`
        ALTER TABLE output_visibility RENAME TO output_visibility_legacy;
        CREATE TABLE output_visibility(
          local_agent_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(local_agent_id, chat_id)
        );
        INSERT INTO output_visibility(local_agent_id, chat_id, mode, updated_at)
        SELECT activations.local_agent_id, legacy.chat_id, legacy.mode, legacy.updated_at
          FROM output_visibility_legacy AS legacy
          CROSS JOIN activations
         WHERE activations.platform = '${PLATFORM_ID}';
        DROP TABLE output_visibility_legacy;
      `);
    }
    const columns = await db.all<{ name: string }[]>("PRAGMA table_info(runtime_sessions)");
    if (!columns.some((column) => column.name === "project_id"))
      await db.exec("ALTER TABLE runtime_sessions ADD COLUMN project_id TEXT REFERENCES projects(project_id)");
    if (!columns.some((column) => column.name === "has_messages"))
      await db.exec("ALTER TABLE runtime_sessions ADD COLUMN has_messages INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((column) => column.name === "model"))
      await db.exec("ALTER TABLE runtime_sessions ADD COLUMN model TEXT");
    if (!columns.some((column) => column.name === "reasoning_effort"))
      await db.exec("ALTER TABLE runtime_sessions ADD COLUMN reasoning_effort TEXT");
    if (!columns.some((column) => column.name === "session_options_json"))
      await db.exec("ALTER TABLE runtime_sessions ADD COLUMN session_options_json TEXT NOT NULL DEFAULT '{}'");
    await db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_sessions_identity ON runtime_sessions(chat_id, agent_id, session_id)",
    );
    const intentColumns = await db.all<{ name: string }[]>("PRAGMA table_info(session_intents)");
    if (!intentColumns.some((column) => column.name === "model"))
      await db.exec("ALTER TABLE session_intents ADD COLUMN model TEXT");
    if (!intentColumns.some((column) => column.name === "reasoning_effort"))
      await db.exec("ALTER TABLE session_intents ADD COLUMN reasoning_effort TEXT");
    if (!intentColumns.some((column) => column.name === "session_options_json"))
      await db.exec("ALTER TABLE session_intents ADD COLUMN session_options_json TEXT NOT NULL DEFAULT '{}'");
    const messageColumns = await db.all<{ name: string }[]>("PRAGMA table_info(clawchat_messages)");
    if (!messageColumns.some((column) => column.name === "rejected_at"))
      await db.exec("ALTER TABLE clawchat_messages ADD COLUMN rejected_at INTEGER");
    if (!messageColumns.some((column) => column.name === "handled_content_json"))
      await db.exec("ALTER TABLE clawchat_messages ADD COLUMN handled_content_json TEXT");
    if (!messageColumns.some((column) => column.name === "handled_at"))
      await db.exec("ALTER TABLE clawchat_messages ADD COLUMN handled_at INTEGER");
    if (!messageColumns.some((column) => column.name === "handling_outcome"))
      await db.exec("ALTER TABLE clawchat_messages ADD COLUMN handling_outcome TEXT");
    const toolRequestColumns = await db.all<{ name: string }[]>("PRAGMA table_info(tool_requests)");
    if (!toolRequestColumns.some((column) => column.name === "attempt_count"))
      await db.exec("ALTER TABLE tool_requests ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
    if (!toolRequestColumns.some((column) => column.name === "record_input_json")) {
      await db.exec("ALTER TABLE tool_requests ADD COLUMN record_input_json TEXT");
      await db.exec("UPDATE tool_requests SET record_input_json = input_json WHERE record_input_json IS NULL");
    }
    if (!toolRequestColumns.some((column) => column.name === "result_truncated"))
      await db.exec("ALTER TABLE tool_requests ADD COLUMN result_truncated INTEGER NOT NULL DEFAULT 0");
    if (!toolRequestColumns.some((column) => column.name === "error_truncated"))
      await db.exec("ALTER TABLE tool_requests ADD COLUMN error_truncated INTEGER NOT NULL DEFAULT 0");
    if (!toolRequestColumns.some((column) => column.name === "session_ref"))
      await db.exec("ALTER TABLE tool_requests ADD COLUMN session_ref TEXT");
    if (!toolRequestColumns.some((column) => column.name === "turn_id"))
      await db.exec("ALTER TABLE tool_requests ADD COLUMN turn_id TEXT");
    if (!toolRequestColumns.some((column) => column.name === "origin"))
      await db.exec("ALTER TABLE tool_requests ADD COLUMN origin TEXT");
    await db.run(
      `UPDATE runtime_sessions AS rs SET has_messages = 1 WHERE has_messages = 0 AND (runtime_session_id IS NOT NULL OR EXISTS (SELECT 1 FROM clawchat_messages AS message WHERE message.local_agent_id = rs.agent_id AND message.chat_id = rs.chat_id AND message.direction = 'inbound' AND message.kind = 'message' AND COALESCE(message.text, '') NOT LIKE '/%' AND message.created_at >= rs.created_at AND NOT EXISTS (SELECT 1 FROM runtime_sessions AS newer WHERE newer.chat_id = rs.chat_id AND newer.agent_id = rs.agent_id AND newer.created_at > rs.created_at AND newer.created_at <= message.created_at)))`,
    );
    const now = Date.now();
    await db.run(
      `INSERT INTO session_intents(chat_id, agent_id, project_id, name, mode, model, reasoning_effort, session_options_json, created_at, updated_at) SELECT chat_id, agent_id, project_id, name, mode, model, reasoning_effort, session_options_json, ?, ? FROM runtime_sessions WHERE is_current = 1 AND has_messages = 0 ON CONFLICT(chat_id, agent_id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, mode = excluded.mode, model = excluded.model, reasoning_effort = excluded.reasoning_effort, session_options_json = excluded.session_options_json, updated_at = excluded.updated_at`,
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

function toolRequestRecord(row: Record<string, unknown>): ToolRequestRecord {
  const parsedInput = parseJsonValue(row.input_json);
  return {
    requestId: stringValue(row.request_id),
    bindingId: stringValue(row.binding_id),
    toolName: stringValue(row.tool_name),
    input:
      parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)
        ? (parsedInput as Record<string, unknown>)
        : {},
    state: stringValue(row.state) as ToolRequestState,
    result: row.result_json == null ? null : parseJsonValue(row.result_json),
    error: nullableString(row.error),
    resultTruncated: numberValue(row.result_truncated) === 1,
    errorTruncated: numberValue(row.error_truncated) === 1,
    sessionRef: nullableString(row.session_ref),
    turnId: nullableString(row.turn_id),
    origin: nullableString(row.origin),
    createdAt: numberValue(row.created_at),
    claimedAt: row.claimed_at == null ? null : numberValue(row.claimed_at),
    settledAt: row.settled_at == null ? null : numberValue(row.settled_at),
    expiresAt: numberValue(row.expires_at),
    attemptCount: numberValue(row.attempt_count),
  };
}

function boundedJson(value: unknown, maximumBytes = 64 * 1024): { value: string; truncated: boolean } {
  const serialized = toJson(value) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return { value: serialized, truncated: false };
  let lower = 0;
  let upper = serialized.length;
  let bounded = JSON.stringify({ truncated: true, preview: "" });
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = JSON.stringify({ truncated: true, preview: serialized.slice(0, middle) });
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      bounded = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return {
    value: bounded,
    truncated: true,
  };
}
function boundedText(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return { value, truncated: false };
  return { value: truncateUtf8(value, maximumBytes), truncated: true };
}
function truncateUtf8(value: string, maximumBytes: number): string {
  let end = Math.min(value.length, maximumBytes);
  while (Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes) end -= 1;
  return value.slice(0, end);
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
function normalizeGroupSettingsRecord(row: GroupSettingsRecord): GroupSettingsRecord {
  const replyMode = row.replyMode;
  if (replyMode !== "all" && replyMode !== "mention") throw new Error("group replyMode must be all or mention");
  if (!Number.isSafeInteger(row.batchDelaySeconds) || row.batchDelaySeconds < 0) {
    throw new Error("group batchDelaySeconds must be a non-negative integer");
  }
  if (!Number.isSafeInteger(row.version) || row.version < 0) {
    throw new Error("group settings version must be a non-negative integer");
  }
  return {
    conversationId: requireStateString(row.conversationId, "group conversationId"),
    muted: row.muted,
    replyMode,
    batchDelaySeconds: row.batchDelaySeconds,
    version: row.version,
  };
}
function groupSettingsRecordFromRow(row: Record<string, unknown>): GroupSettingsRecord {
  return {
    conversationId: stringValue(row.conversation_id),
    muted: Number(row.muted) === 1,
    replyMode: stringValue(row.reply_mode) as GroupReplyMode,
    batchDelaySeconds: numberValue(row.batch_delay_seconds),
    version: numberValue(row.version),
  };
}
function livewareExposureFromRow(row: Record<string, unknown>): LivewareExposureRecord | null {
  const accessPolicy = stringValue(row.access_policy);
  if (accessPolicy !== "private" && accessPolicy !== "public") return null;
  return {
    ownerUserId: stringValue(row.owner_user_id),
    localAgentId: stringValue(row.local_agent_id),
    appId: stringValue(row.app_id),
    publicUrl: stringValue(row.public_url),
    accessPolicy,
  };
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
function preserveConnectOwnedMessageMetadata(
  stored: TranscriptBlock | null,
  input: TranscriptBlockInput,
): TranscriptBlockInput {
  if (
    stored?.type === "message" &&
    input.type === "message" &&
    stored.role === "assistant" &&
    input.role === "assistant" &&
    stored.origin === "runtime" &&
    input.origin === "runtime" &&
    stored.media &&
    !input.media
  ) {
    return {
      ...input,
      plainText: stored.plainText,
      markdown: stored.markdown,
      media: stored.media,
    };
  }
  if (
    stored?.type !== "message" ||
    input.type !== "message" ||
    stored.role !== "user" ||
    input.role !== "user" ||
    input.origin !== "runtime" ||
    (stored.origin !== "client" && stored.origin !== "clawchat")
  ) {
    return input;
  }
  return {
    ...input,
    origin: stored.origin,
    author: stored.author,
    ...(connectPromptMatchesRuntimeHistory(stored.plainText, input.plainText)
      ? { plainText: stored.plainText, markdown: stored.markdown }
      : {}),
    ...(stored.sender ? { sender: stored.sender } : {}),
    ...(stored.conversationType ? { conversationType: stored.conversationType } : {}),
    ...(stored.media && !input.media ? { media: stored.media } : {}),
  };
}
function connectPromptMatchesRuntimeHistory(connectPrompt: string, runtimePrompt: string): boolean {
  return (
    connectPrompt === runtimePrompt || (connectPrompt.startsWith("/") && `$${connectPrompt.slice(1)}` === runtimePrompt)
  );
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
function stringRecordFromJson(value: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(stringValue(value)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
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
    model: nullableString(row.model),
    reasoningEffort: nullableString(row.reasoning_effort),
    sessionOptions: stringRecordFromJson(row.session_options_json),
    hasMessages: Boolean(row.has_messages),
    isCurrent: Boolean(row.is_current),
    updatedAt: numberValue(row.updated_at),
  };
}

function sessionLifecycleOperationFromRow(row: Record<string, unknown>): SessionLifecycleOperationRecord {
  return {
    operationId: stringValue(row.operation_id),
    sessionRef: stringValue(row.session_ref),
    action: stringValue(row.action) as SessionLifecycleAction,
    bindingId: stringValue(row.binding_id),
    runtimeThreadId: stringValue(row.runtime_thread_id),
    state: stringValue(row.state) as SessionLifecycleOperationState,
    createdAt: numberValue(row.created_at),
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
    model: nullableString(row.model),
    reasoningEffort: nullableString(row.reasoning_effort),
    sessionOptions: stringRecordFromJson(row.session_options_json),
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
