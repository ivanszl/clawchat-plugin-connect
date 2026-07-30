import { Database } from "bun:sqlite";

const dbPath = process.argv[2];
const holdMilliseconds = Number(process.argv[3] ?? "250");
if (!dbPath) throw new Error("database path is required");

const database = new Database(dbPath);
database.exec("PRAGMA journal_mode = WAL");
database.exec("BEGIN IMMEDIATE");
console.log("locked");
await Bun.sleep(holdMilliseconds);
database.exec("COMMIT");
database.close();
