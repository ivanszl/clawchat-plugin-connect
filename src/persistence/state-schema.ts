import { PLATFORM_ID } from "../types";
import type { SqliteDb } from "./sqlite";
import { nullableString, stringValue } from "./state-codecs";
import type { SessionRefTarget } from "./state-types";

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

export async function migrateStateSchema(db: SqliteDb): Promise<void> {
  const projectColumns = await db.all<{ name: string }[]>("PRAGMA table_info(projects)");
  if (projectColumns.some((column) => column.name === "additional_directories_json")) {
    const affected = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM projects WHERE additional_directories_json <> '[]'",
    );
    await db.exec("ALTER TABLE projects DROP COLUMN additional_directories_json");
    if ((affected?.count ?? 0) > 0)
      console.warn(`Removed Project additional directories from ${affected?.count ?? 0} Project(s).`);
  }
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
