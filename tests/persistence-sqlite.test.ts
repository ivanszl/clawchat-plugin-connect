import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqliteAdapter } from "../src/persistence/sqlite";

test("a write transaction survives a concurrent writer after reading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-sqlite-"));
  const dbPath = join(directory, "state.sqlite");
  const markerPath = join(directory, "writer-started");
  const database = new Database(dbPath, { create: true });
  const adapter = new BunSqliteAdapter(database);
  let writer: ReturnType<typeof Bun.spawn> | undefined;

  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.query("INSERT INTO records(id, value) VALUES (1, 'before')").run();

    let transactionError: unknown;
    try {
      adapter.transaction((run, get) => {
        expect(get<{ value: string }>("SELECT value FROM records WHERE id = 1")).toEqual({ value: "before" });
        writer = Bun.spawn(
          [
            process.execPath,
            "-e",
            `
              import { Database } from "bun:sqlite";
              import { writeFileSync } from "node:fs";
              const database = new Database(process.env.LOCK_REPRO_DB);
              database.exec("PRAGMA busy_timeout = 5000");
              writeFileSync(process.env.LOCK_REPRO_MARKER, "started");
              database.query("INSERT INTO records(id, value) VALUES (2, 'concurrent')").run();
              database.close();
            `,
          ],
          {
            env: {
              ...process.env,
              LOCK_REPRO_DB: dbPath,
              LOCK_REPRO_MARKER: markerPath,
            },
            stderr: "pipe",
            stdout: "pipe",
          },
        );
        const deadline = Date.now() + 3_000;
        while (!existsSync(markerPath) && Date.now() < deadline) Bun.sleepSync(10);
        if (!existsSync(markerPath)) throw new Error("concurrent writer did not start");
        Bun.sleepSync(100);
        run("UPDATE records SET value = 'after' WHERE id = 1");
      });
    } catch (error) {
      transactionError = error;
    }

    expect(transactionError).toBeUndefined();
    expect(writer).toBeDefined();
    expect(await writer?.exited).toBe(0);
    expect(database.query("SELECT id, value FROM records ORDER BY id").all()).toEqual([
      { id: 1, value: "after" },
      { id: 2, value: "concurrent" },
    ]);
  } finally {
    writer?.kill();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
