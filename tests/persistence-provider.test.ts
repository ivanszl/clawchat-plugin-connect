import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECT_SQLITE_APPLICATION_ID,
  CONNECT_SQLITE_SCHEMA_VERSION,
  createSqlitePersistenceService,
} from "../src/persistence/service";
import { BunSqliteAdapter } from "../src/persistence/sqlite";
import { createStateSchema } from "../src/persistence/state-schema";

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-persistence-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("official SQLite persistence service", () => {
  for (const database of ["file-backed", ":memory:"] as const) {
    it(`runs Core state behavior against ${database} storage`, async () => {
      await withTemporaryDirectory(async (directory) => {
        const dbPath = database === ":memory:" ? database : join(directory, "state.sqlite");
        const persistence = createSqlitePersistenceService({ dbPath });
        await persistence.initialize();

        await persistence.state.upsertActivation({
          localAgentId: "primary",
          accessToken: "access-token",
          refreshToken: null,
          serverAgentId: "server-agent",
          userId: "user",
          ownerUserId: "owner",
          conversationId: "conversation",
        });
        expect(await persistence.state.getActivation("primary")).toMatchObject({
          localAgentId: "primary",
          ownerUserId: "owner",
        });

        await persistence.close();
      });
    });
  }

  it("migrates the supported unversioned schema transactionally and preserves its data", async () => {
    await withTemporaryDirectory(async (directory) => {
      const dbPath = join(directory, "state.sqlite");
      const legacyDatabase = new Database(dbPath, { create: true });
      const legacyAdapter = new BunSqliteAdapter(legacyDatabase);
      await createStateSchema(legacyAdapter);
      await legacyAdapter.run(
        "INSERT INTO device_state(id, device_id, updated_at) VALUES (1, ?, ?)",
        "legacy-device",
        1,
      );
      await legacyAdapter.close();

      const persistence = createSqlitePersistenceService({ dbPath });
      await persistence.initialize();
      expect(await persistence.state.getOrCreateDeviceId()).toBe("legacy-device");
      await persistence.close();

      const migrated = new Database(dbPath);
      expect(migrated.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id).toBe(
        CONNECT_SQLITE_APPLICATION_ID,
      );
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
        CONNECT_SQLITE_SCHEMA_VERSION,
      );
      migrated.close();
    });
  });

  it("migrates schema 2 Plugin Durable State into Activation Generation 1 without losing data", async () => {
    await withTemporaryDirectory(async (directory) => {
      const dbPath = join(directory, "state.sqlite");
      const legacyDatabase = new Database(dbPath, { create: true });
      const legacyAdapter = new BunSqliteAdapter(legacyDatabase);
      await createStateSchema(legacyAdapter);
      await legacyAdapter.exec(`
        DROP TABLE plugin_durable_state;
        CREATE TABLE plugin_durable_state(
          plugin_id TEXT NOT NULL,
          capability_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          lifetime TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(plugin_id, capability_id, instance_id, lifetime, scope_key)
        );
        INSERT INTO plugin_durable_state VALUES(
          'test.migrated', 'runtime', 'binding-a', 'binding', 'binding-a', 1, 2, '{"phase":"ready"}', 1
        );
        PRAGMA application_id = ${CONNECT_SQLITE_APPLICATION_ID};
        PRAGMA user_version = 2;
      `);
      await legacyAdapter.close();

      const persistence = createSqlitePersistenceService({ dbPath });
      await persistence.initialize();
      await expect(
        persistence.state.readPluginDurableState({
          pluginId: "test.migrated",
          activationGeneration: 1,
          capabilityId: "runtime",
          instanceId: "binding-a",
          lifetime: "binding",
          scopeKey: "binding-a",
        }),
      ).resolves.toEqual({ schemaVersion: 1, revision: 2, value: { phase: "ready" } });
      await persistence.close();
    });
  });

  it("rejects a partial schema before any Core state adapter can activate", async () => {
    await withTemporaryDirectory(async (directory) => {
      const dbPath = join(directory, "state.sqlite");
      const partial = new Database(dbPath, { create: true });
      partial.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      partial.close();

      const persistence = createSqlitePersistenceService({ dbPath });
      await expect(persistence.initialize()).rejects.toThrow("partial or unsupported Connect SQLite schema");
      await expect(persistence.state.getOrCreateDeviceId()).rejects.toThrow(
        "partial or unsupported Connect SQLite schema",
      );
    });
  });
});
