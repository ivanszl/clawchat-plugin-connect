import { Database, type SQLQueryBindings } from "bun:sqlite";

export { Database };
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export class BunSqliteAdapter {
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
      all: <Row>(sql: string, ...bindings: SQLQueryBindings[]) => Row[],
    ) => T,
  ): T {
    return this.database.transaction(() =>
      callback(
        (sql, ...bindings) => this.database.query<unknown, SQLQueryBindings[]>(sql).run(...bindings),
        <Row>(sql: string, ...bindings: SQLQueryBindings[]) =>
          this.database.query<Row, SQLQueryBindings[]>(sql).get(...bindings),
        <Row>(sql: string, ...bindings: SQLQueryBindings[]) =>
          this.database.query<Row, SQLQueryBindings[]>(sql).all(...bindings),
      ),
    )();
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

export type SqliteDb = BunSqliteAdapter;
