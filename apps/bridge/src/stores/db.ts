import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  `CREATE TABLE api_keys (
     id TEXT PRIMARY KEY,
     hash BLOB NOT NULL,
     prefix TEXT NOT NULL,
     created_at TEXT NOT NULL,
     revoked_at TEXT
   );
   CREATE TABLE connections (
     id TEXT PRIMARY KEY,
     adapter_type TEXT NOT NULL,
     display_name TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     permission_status TEXT NOT NULL,
     permission_ref TEXT,
     paid INTEGER NOT NULL DEFAULT 0,
     max_concurrency INTEGER NOT NULL DEFAULT 1,
     max_queue INTEGER NOT NULL DEFAULT 10,
     settings_json TEXT NOT NULL DEFAULT '{}',
     secret_ref TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value_json TEXT NOT NULL
   );
   CREATE TABLE request_events (
     request_id TEXT PRIMARY KEY,
     ts TEXT NOT NULL,
     connection_id TEXT,
     status TEXT NOT NULL,
     error_code TEXT,
     duration_ms INTEGER NOT NULL,
     route_changed INTEGER NOT NULL DEFAULT 0,
     streamed INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX request_events_ts ON request_events (ts);`,
];

/** Opens (and migrates) the local database. ":memory:" is accepted for tests. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
