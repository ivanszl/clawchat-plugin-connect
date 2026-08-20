import type { SqliteDb } from "./sqlite";
import { nullableString, stringValue } from "./state-codecs";
import type { SessionRefTarget } from "./state-types";

export const AMBIGUOUS_LEGACY_OWNER_DIAGNOSTIC =
  "Connect found legacy ClawChat activations for multiple owners without an Installation Owner. Startup is blocked to prevent cross-owner Agent Bindings. Run `clawchat-connect owner reset` to purge legacy owner-scoped state, then activate the intended owner again.";

export interface StateSchemaMigrationOptions {
  allowAmbiguousLegacyOwnerReset?: boolean;
}

export async function createStateSchema(db: SqliteDb): Promise<void> {
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
    CREATE TABLE IF NOT EXISTS installation_owner(
      id INTEGER PRIMARY KEY CHECK(id = 1),
      owner_user_id TEXT NOT NULL,
      established_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_state(
      id INTEGER PRIMARY KEY CHECK(id = 1),
      device_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_catalog_entries(
      binding_id TEXT NOT NULL,
      workspace_ref TEXT NOT NULL COLLATE NOCASE CHECK(length(workspace_ref) = 8),
      runtime_identity_key TEXT,
      source TEXT NOT NULL CHECK(source IN ('default', 'runtime')),
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      selectable INTEGER NOT NULL CHECK(selectable IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(binding_id, workspace_ref),
      UNIQUE(binding_id, runtime_identity_key),
      UNIQUE(binding_id, root_path)
    );
    CREATE TABLE IF NOT EXISTS workspace_catalog_state(
      binding_id TEXT PRIMARY KEY,
      discovery_status TEXT NOT NULL CHECK(discovery_status IN ('complete', 'partial', 'unavailable')),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_sessions(
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      runtime_session_id TEXT,
      workspace_ref TEXT,
      name TEXT,
      mode TEXT,
      model TEXT,
      reasoning_effort TEXT,
      session_options_json TEXT NOT NULL DEFAULT '{}',
      has_messages INTEGER NOT NULL DEFAULT 0,
      binding_locked INTEGER NOT NULL DEFAULT 0,
      is_current INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(chat_id, agent_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS session_intents(
      chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      workspace_ref TEXT,
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
      runtime_availability TEXT CHECK(runtime_availability IN ('available', 'startup-unavailable')),
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
    CREATE TABLE IF NOT EXISTS turn_outbox(
      submission_id TEXT PRIMARY KEY,
      session_ref TEXT NOT NULL COLLATE NOCASE REFERENCES session_refs(session_ref) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      prompt TEXT NOT NULL,
      selection_json TEXT,
      staging_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'delivering', 'accepted', 'failed')),
      turn_id TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_ref, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_outbox_delivery
      ON turn_outbox(state, created_at, submission_id);
    CREATE INDEX IF NOT EXISTS idx_turn_outbox_session_order
      ON turn_outbox(session_ref, created_at, submission_id);
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
    CREATE TABLE IF NOT EXISTS plugin_durable_state(
      plugin_id TEXT NOT NULL,
      activation_generation INTEGER NOT NULL CHECK(activation_generation >= 1),
      capability_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      lifetime TEXT NOT NULL CHECK(lifetime IN ('installation', 'owner', 'binding')),
      scope_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(plugin_id, activation_generation, capability_id, instance_id, lifetime, scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_durable_state_scope
      ON plugin_durable_state(lifetime, scope_key);
    CREATE TABLE IF NOT EXISTS client_event_retention(
      id INTEGER PRIMARY KEY CHECK(id = 1),
      floor_cursor INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO client_event_retention(id, floor_cursor) VALUES (1, 0);
  `);
}

export async function migratePluginDurableStateActivationGeneration(db: SqliteDb): Promise<void> {
  await db.exec(`
    DROP INDEX IF EXISTS idx_plugin_durable_state_scope;
    ALTER TABLE plugin_durable_state RENAME TO plugin_durable_state_without_generation;
    CREATE TABLE plugin_durable_state(
      plugin_id TEXT NOT NULL,
      activation_generation INTEGER NOT NULL CHECK(activation_generation >= 1),
      capability_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      lifetime TEXT NOT NULL CHECK(lifetime IN ('installation', 'owner', 'binding')),
      scope_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(plugin_id, activation_generation, capability_id, instance_id, lifetime, scope_key)
    );
    INSERT INTO plugin_durable_state(
      plugin_id, activation_generation, capability_id, instance_id, lifetime, scope_key,
      schema_version, revision, state_json, updated_at
    )
    SELECT plugin_id, 1, capability_id, instance_id, lifetime, scope_key,
           schema_version, revision, state_json, updated_at
      FROM plugin_durable_state_without_generation;
    DROP TABLE plugin_durable_state_without_generation;
    CREATE INDEX idx_plugin_durable_state_scope
      ON plugin_durable_state(lifetime, scope_key);
  `);
}

export async function migrateRuntimeModelSelections(db: SqliteDb): Promise<void> {
  for (const table of ["runtime_sessions", "session_intents"] as const) {
    const rows = await db.all<Array<{ rowid: number; model: string }>>(
      `SELECT rowid, model FROM ${table} WHERE model IS NOT NULL`,
    );
    for (const row of rows) {
      let alreadyStructured = false;
      try {
        const parsed = JSON.parse(row.model) as unknown;
        alreadyStructured =
          Boolean(parsed) &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof (parsed as Record<string, unknown>).model === "string";
      } catch {
        // Legacy model identifiers were stored as unencoded text.
      }
      if (alreadyStructured) continue;
      await db.run(`UPDATE ${table} SET model = ? WHERE rowid = ?`, JSON.stringify({ model: row.model }), row.rowid);
    }
  }
}

export async function resetStateForWorkspaceCutover(db: SqliteDb): Promise<void> {
  await db.exec(`
    DROP TABLE IF EXISTS liveware_exposure;
    DROP TABLE IF EXISTS liveware_exposures;
    DROP TABLE IF EXISTS runtime_workspace_mappings;
    DROP TABLE IF EXISTS runtime_sessions;
    DROP TABLE IF EXISTS session_intents;
    DROP TABLE IF EXISTS projects;
  `);
  await createStateSchema(db);
  await db.exec(`
    DELETE FROM activations;
    DELETE FROM installation_owner;
    DELETE FROM workspace_catalog_entries;
    DELETE FROM workspace_catalog_state;
    DELETE FROM session_refs;
    DELETE FROM session_lifecycle_operations;
    DELETE FROM output_visibility;
    DELETE FROM group_settings_snapshots;
    DELETE FROM group_settings;
    DELETE FROM clawchat_messages;
    DELETE FROM protocol_delivery_state;
    DELETE FROM protocol_inbox;
    DELETE FROM protocol_delivery_quarantine;
    DELETE FROM protocol_event_dedup;
    DELETE FROM runtime_statuses;
    DELETE FROM tool_requests;
    DELETE FROM client_events;
    DELETE FROM client_commands;
    DELETE FROM client_event_retention;
    INSERT INTO client_event_retention(id, floor_cursor) VALUES (1, 0);
    DELETE FROM transcript_blocks;
    DELETE FROM output_visibility;
    DELETE FROM plugin_durable_state WHERE lifetime <> 'installation';
  `);
}

export async function backfillSessionRefs(
  db: SqliteDb,
  getOrCreateSessionRef: (target: SessionRefTarget) => Promise<string>,
): Promise<void> {
  const sessions = await db.all<Record<string, unknown>[]>(
    "SELECT chat_id, agent_id, session_id, runtime_session_id FROM runtime_sessions",
  );
  for (const session of sessions) {
    await getOrCreateSessionRef({
      chatId: stringValue(session.chat_id),
      agentId: stringValue(session.agent_id),
      sessionId: stringValue(session.session_id),
      runtimeSessionId: nullableString(session.runtime_session_id),
    });
  }
}
