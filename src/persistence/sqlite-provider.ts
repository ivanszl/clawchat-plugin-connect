import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { PLATFORM_ID } from "../types";
import { BunSqliteAdapter, Database, SQLITE_BUSY_TIMEOUT_MS, type SqliteDb } from "./sqlite";
import {
  createStateSchema,
  migratePluginDurableStateActivationGeneration,
  resetStateForWorkspaceCutover,
} from "./state-schema";

export const CONNECT_SQLITE_APPLICATION_ID = 0x43434f4e;
export const CONNECT_SQLITE_SCHEMA_VERSION = 3;

const REQUIRED_STATE_TABLES = [
  "activations",
  "installation_owner",
  "device_state",
  "workspace_catalog_entries",
  "workspace_catalog_state",
  "runtime_sessions",
  "session_intents",
  "session_refs",
  "output_visibility",
  "group_settings_snapshots",
  "group_settings",
  "clawchat_messages",
  "protocol_delivery_state",
  "protocol_inbox",
  "protocol_delivery_quarantine",
  "protocol_event_dedup",
  "runtime_statuses",
  "client_commands",
  "tool_requests",
  "turn_submission_cancellations",
  "transcript_blocks",
  "client_events",
  "plugin_durable_state",
  "client_event_retention",
] as const;
const LEGACY_CONNECT_TABLES = new Set([
  "activations",
  "device_state",
  "liveware_exposure",
  "liveware_exposures",
  "output_visibility",
  "projects",
  "runtime_sessions",
  "session_refs",
]);

const REQUIRED_COLUMNS = {
  activations: ["platform", "local_agent_id", "owner_user_id"],
  installation_owner: ["id", "owner_user_id"],
  device_state: ["id", "device_id"],
  workspace_catalog_entries: ["binding_id", "workspace_ref", "root_path", "selectable"],
  output_visibility: ["local_agent_id", "chat_id", "mode"],
  runtime_sessions: ["chat_id", "agent_id", "session_id", "workspace_ref", "binding_locked"],
  plugin_durable_state: [
    "plugin_id",
    "activation_generation",
    "capability_id",
    "instance_id",
    "lifetime",
    "scope_key",
    "schema_version",
    "revision",
    "state_json",
  ],
} as const;

export interface SqlitePersistenceProviderOptions {
  readonly dbPath: string;
}

export interface InitializedSqlitePersistence {
  readonly db: SqliteDb;
  readonly ambiguousLegacyOwnerState: boolean;
}

export class OfficialSqlitePersistenceProvider {
  readonly dbPath: string;
  private db: SqliteDb | null = null;
  private ambiguousLegacyOwnerState = false;

  constructor(options: SqlitePersistenceProviderOptions) {
    this.dbPath = options.dbPath;
    if (this.dbPath !== ":memory:" && !isAbsolute(this.dbPath)) {
      throw new Error("stateDbPath must be an absolute path or :memory:");
    }
  }
  async initialize(allowAmbiguousLegacyOwnerReset = false): Promise<InitializedSqlitePersistence> {
    if (this.db) {
      return { db: this.db, ambiguousLegacyOwnerState: this.ambiguousLegacyOwnerState };
    }
    if (this.dbPath !== ":memory:") await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const db = new BunSqliteAdapter(new Database(this.dbPath, { create: true }));
    try {
      await db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      await db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      await db.exec("PRAGMA journal_mode = WAL");
      await db.exec("PRAGMA foreign_keys = ON");
      this.ambiguousLegacyOwnerState = await initializeSchema(db, allowAmbiguousLegacyOwnerReset);
      if (this.dbPath !== ":memory:") await chmod(this.dbPath, 0o600).catch(() => undefined);
      this.db = db;
      return { db, ambiguousLegacyOwnerState: this.ambiguousLegacyOwnerState };
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = null;
    this.ambiguousLegacyOwnerState = false;
  }
}

async function initializeSchema(db: SqliteDb, _allowAmbiguousLegacyOwnerReset = false): Promise<boolean> {
  const applicationId = await pragmaNumber(db, "application_id");
  const userVersion = await pragmaNumber(db, "user_version");
  if (applicationId !== 0 && applicationId !== CONNECT_SQLITE_APPLICATION_ID) {
    throw new Error(`SQLite database belongs to application ${applicationId}, not ClawChat Connect`);
  }
  if (userVersion < 0 || userVersion > CONNECT_SQLITE_SCHEMA_VERSION) {
    throw new Error(`unsupported Connect SQLite schema version ${userVersion}`);
  }
  if (applicationId === 0 && userVersion === 0) {
    const tables = await stateTableNames(db);
    if (tables.length > 0 && !tables.some((table) => LEGACY_CONNECT_TABLES.has(table))) {
      throw new Error("partial or unsupported Connect SQLite schema");
    }
  }

  await db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion < 2) {
      await resetStateForWorkspaceCutover(db);
    } else if (userVersion === 2) {
      await migratePluginDurableStateActivationGeneration(db);
    } else {
      await createStateSchema(db);
    }
    if (userVersion < CONNECT_SQLITE_SCHEMA_VERSION) {
      await db.exec(`PRAGMA application_id = ${CONNECT_SQLITE_APPLICATION_ID}`);
      await db.exec(`PRAGMA user_version = ${CONNECT_SQLITE_SCHEMA_VERSION}`);
      await createStateSchema(db);
    }
    await validateCurrentSchema(db);
    const legacyOwners = await db.all<Array<{ owner_user_id: string }>>(
      `SELECT DISTINCT TRIM(owner_user_id) AS owner_user_id
         FROM activations
        WHERE platform = ? AND TRIM(owner_user_id) <> ''
        ORDER BY owner_user_id`,
      PLATFORM_ID,
    );
    const owner = await db.get<{ owner_user_id?: string }>("SELECT owner_user_id FROM installation_owner WHERE id = 1");
    if (!owner?.owner_user_id && legacyOwners.length === 1) {
      await db.run(
        "INSERT INTO installation_owner(id, owner_user_id, established_at) VALUES (1, ?, ?)",
        legacyOwners[0]?.owner_user_id,
        Date.now(),
      );
    }
    await db.exec("COMMIT");
    return !owner?.owner_user_id && legacyOwners.length > 1;
  } catch (error) {
    await db.exec("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function validateCurrentSchema(db: SqliteDb): Promise<void> {
  const applicationId = await pragmaNumber(db, "application_id");
  const userVersion = await pragmaNumber(db, "user_version");
  if (applicationId !== CONNECT_SQLITE_APPLICATION_ID || userVersion !== CONNECT_SQLITE_SCHEMA_VERSION) {
    throw new Error("partial or unsupported Connect SQLite schema metadata");
  }
  assertRequiredTables(await stateTableNames(db));
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set((await db.all<{ name: string }[]>(`PRAGMA table_info(${table})`)).map((row) => row.name));
    if (required.some((column) => !columns.has(column))) {
      throw new Error(`partial or unsupported Connect SQLite schema: ${table} columns are incomplete`);
    }
  }
}

function assertRequiredTables(
  tables: readonly string[],
  requiredTables: readonly string[] = REQUIRED_STATE_TABLES,
): void {
  const available = new Set(tables);
  const missing = requiredTables.filter((table) => !available.has(table));
  if (missing.length > 0) {
    throw new Error(`partial or unsupported Connect SQLite schema: missing ${missing.join(", ")}`);
  }
}

async function stateTableNames(db: SqliteDb): Promise<string[]> {
  const rows = await db.all<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

async function pragmaNumber(db: SqliteDb, name: "application_id" | "user_version"): Promise<number> {
  const row = await db.get<Record<string, number>>(`PRAGMA ${name}`);
  const value = row?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`SQLite PRAGMA ${name} is malformed`);
  return value as number;
}
