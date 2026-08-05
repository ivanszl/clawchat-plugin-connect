import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { inboundContentDigest, protocolDeliveryContentJson } from "../clawchat/inbound-identity";
import type { ClientViewEvent, RuntimeInteractionBlock, TranscriptBlock } from "../client-contract";
import { defaultStateDbPath } from "../config";
import type { RuntimeInputIdentity } from "../runtime/types";
import {
  type ActivationCredentials,
  type LivewareExposureRecord,
  type OutputVisibility,
  PLATFORM_ID,
  type ProjectRecord,
  type RuntimeSessionRecord,
  type RuntimeStatus,
  type SessionIntentRecord,
} from "../types";

export * from "./state-types";

import {
  assertSessionRefCanAttach,
  attachSessionRef,
  generateSessionRef,
  normalizeGeneratedSessionRef,
  runtimeSessionSelect,
  type SessionRefRow,
} from "./session-refs";
import { BunSqliteAdapter, Database, SQLITE_BUSY_TIMEOUT_MS, type SqliteDb } from "./sqlite";
import {
  boundedJson,
  boundedText,
  groupSettingsRecordFromRow,
  livewareExposureFromRow,
  normalizeGroupSettingsRecord,
  nullableString,
  numberValue,
  parseJsonValue,
  preserveConnectOwnedMessageMetadata,
  projectFromRow,
  requireStateString,
  runtimeSessionFromRow,
  sameTranscriptPayload,
  sessionIntentFromRow,
  sessionLifecycleOperationFromRow,
  settleTranscriptBlock,
  stringRecordFromJson,
  stringValue,
  toJson,
  toolRequestRecord,
} from "./state-codecs";
import { backfillSessionRefs, createStateSchema, migrateStateSchema } from "./state-schema";
import type {
  AdoptRuntimeThreadRefInput,
  ClientCommandClaim,
  ClientCommandOutcome,
  ConnectStateOptions,
  GroupSettingsRecord,
  GroupSettingsSnapshotRecord,
  HandledInboundMessage,
  InboundHandlingOutcome,
  InsertProjectInput,
  MessageInput,
  ProtocolDeliveryInput,
  ProtocolDeliveryQuarantineInput,
  ProtocolDeliveryQuarantineRecord,
  ProtocolDeliveryState,
  ResolveOrMaterializeRuntimeSessionInput,
  RuntimeWorkspaceMappingRecord,
  SessionLifecycleAction,
  SessionLifecycleOperationRecord,
  SessionLifecycleOperationState,
  SessionRefRecord,
  SessionRefTarget,
  SetSessionIntentInput,
  StoredClientEvent,
  ToolRequestRecord,
  TranscriptBlockInput,
  UpsertRuntimeSessionInput,
} from "./state-types";
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
      await createStateSchema(this.db);
      await migrateStateSchema(this.db);
      await backfillSessionRefs(this.db, (target) => this.getOrCreateSessionRef(target));
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
      `INSERT INTO projects(project_id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      input.projectId,
      input.name,
      input.rootPath,
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
  async listProjectedInboundSessionRefs(agentId: string, chatId: string, messageId: string): Promise<string[]> {
    const db = await this.requireDb();
    const rows = await db.all<Array<{ session_ref: string }>>(
      `SELECT DISTINCT block.session_ref
       FROM transcript_blocks AS block
       JOIN session_refs AS ref ON ref.session_ref = block.session_ref
       WHERE ref.agent_id = ? AND ref.chat_id = ?
         AND block.block_id = ? AND block.origin = 'clawchat'`,
      requireStateString(agentId, "agentId"),
      requireStateString(chatId, "chatId"),
      requireStateString(messageId, "messageId"),
    );
    return rows.map((row) => row.session_ref);
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

  async markReconciledInboundIdentity(agentId: string, identity: RuntimeInputIdentity): Promise<number> {
    const db = await this.requireDb();
    const normalizedAgentId = requireStateString(agentId, "agentId");
    const handledAt = Date.now();
    const messages = new Map(
      [...identity.actionable, ...identity.context].map((message) => [message.messageId, message] as const),
    );
    return db.transaction((run, get) => {
      let handled = 0;
      for (const message of messages.values()) {
        const current = get<{ raw_json?: string }>(
          `SELECT raw_json FROM clawchat_messages
           WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?`,
          normalizedAgentId,
          requireStateString(message.messageId, "messageId"),
        );
        if (!current || inboundContentDigest(current.raw_json) !== message.contentDigest) continue;
        const content = protocolDeliveryContentJson(current.raw_json);
        const updated = run(
          `UPDATE clawchat_messages
           SET handled_content_json = ?, handled_at = ?, handling_outcome = 'runtime'
           WHERE local_agent_id = ? AND direction = 'inbound' AND kind = 'message' AND message_id = ?
             AND raw_json = ?`,
          content,
          handledAt,
          normalizedAgentId,
          message.messageId,
          current.raw_json ?? null,
        );
        handled += updated.changes;
      }
      return handled;
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

  async settleStreamingTranscriptBlocks(
    sessionRef: string,
    sequenceRange: { first: number; next: number },
    state: "error" | "cancelled",
  ): Promise<number> {
    if (
      !Number.isSafeInteger(sequenceRange.first) ||
      !Number.isSafeInteger(sequenceRange.next) ||
      sequenceRange.first < 0 ||
      sequenceRange.next <= sequenceRange.first
    ) {
      throw new Error("Transcript sequence range is invalid");
    }
    const db = await this.requireDb();
    const now = Date.now();
    return db.transaction((run, get, all) => {
      const rows = all<{ block_id: string }>(
        `SELECT block_id FROM transcript_blocks
         WHERE session_ref = ? AND sequence >= ? AND sequence < ?
           AND block_type != 'runtime-interaction'
           AND (state IN ('pending', 'streaming') OR block_type = 'subagent')
         ORDER BY sequence`,
        sessionRef,
        sequenceRange.first,
        sequenceRange.next,
      );
      let settled = 0;
      for (const candidate of rows) {
        const current = get<{ revision: number; block_json: string }>(
          `SELECT revision, block_json FROM transcript_blocks
           WHERE session_ref = ? AND block_id = ? AND sequence >= ? AND sequence < ?
             AND block_type != 'runtime-interaction'
             AND (state IN ('pending', 'streaming') OR block_type = 'subagent')`,
          sessionRef,
          candidate.block_id,
          sequenceRange.first,
          sequenceRange.next,
        );
        if (!current) continue;
        let stored: TranscriptBlock;
        try {
          stored = JSON.parse(current.block_json) as TranscriptBlock;
        } catch {
          continue;
        }
        const settledInput = settleTranscriptBlock(stored, state);
        if (sameTranscriptPayload(stored, settledInput)) continue;
        const block = {
          ...settledInput,
          revision: current.revision + 1,
          sequence: stored.sequence,
          createdAt: stored.createdAt,
          updatedAt: new Date(now).toISOString(),
        } as TranscriptBlock;
        const updated = run(
          `UPDATE transcript_blocks SET revision = ?, state = ?, block_json = ?, updated_at = ?
           WHERE session_ref = ? AND block_id = ? AND revision = ?
             AND block_type != 'runtime-interaction'
             AND (state IN ('pending', 'streaming') OR block_type = 'subagent')`,
          block.revision,
          block.state,
          JSON.stringify(block),
          now,
          sessionRef,
          candidate.block_id,
          current.revision,
        );
        if (updated.changes !== 1) throw new Error("Runtime Turn transcript changed during settlement");
        const event = {
          type: "transcript.block-upserted",
          cursor: 0,
          sessionRef,
          revision: block.revision,
          block,
        } satisfies ClientViewEvent;
        run(
          "INSERT INTO client_events(event_type, entity_ref, revision, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
          event.type,
          sessionRef,
          event.revision,
          JSON.stringify(event),
          now,
        );
        settled += 1;
      }
      return settled;
    });
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
}
export function createStateStore(options?: ConnectStateOptions): ConnectStateStore {
  return new ConnectStateStore(options);
}
