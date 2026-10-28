import { DatabaseSync } from "node:sqlite";
import type { ConnectionRecord, ConnectionType } from "@ownai/contracts";

/**
 * ADR-009: node:sqlite, so the bridge sidecar needs no native addon to compile.
 * This file holds only configuration and content-free metadata. Provider secrets
 * never appear here (ADR-001, ADR-010).
 */

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS connections (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  provider       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  consumption    TEXT NOT NULL,
  model          TEXT NOT NULL,
  alias          TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  permission     TEXT NOT NULL,
  secret_ref     TEXT,
  fallback_ids   TEXT NOT NULL DEFAULT '[]',
  options        TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_keys (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY,
  ts               TEXT NOT NULL,
  request_id       TEXT NOT NULL,
  connection_id    TEXT NOT NULL,
  route            TEXT NOT NULL,
  consumption      TEXT NOT NULL,
  model_confidence TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  duration_ms      INTEGER NOT NULL,
  bytes_in         INTEGER,
  bytes_out        INTEGER
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** FR (privacy): local event metadata is kept for 7 days, then dropped. */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ConnectionRow {
  id: string;
  type: string;
  provider: string;
  kind: string;
  consumption: string;
  model: string;
  alias: string;
  enabled: number;
  permission: string;
  secret_ref: string | null;
  fallback_ids: string;
  options: string;
  created_at: string;
  updated_at: string;
}

interface KeyRow {
  id: string;
  label: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
}

export class BridgeStore {
  private constructor(readonly db: DatabaseSync) {}

  static open(file: string): BridgeStore {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(MIGRATIONS);
    return new BridgeStore(db);
  }

  static inMemory(): BridgeStore {
    return BridgeStore.open(":memory:");
  }

  close(): void {
    this.db.close();
  }

  // --- connections ---

  listConnections(): ConnectionRecord[] {
    const rows = this.db.prepare("SELECT * FROM connections ORDER BY created_at").all() as unknown as ConnectionRow[];
    return rows.map(toConnection);
  }

  getConnection(id: string): ConnectionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as unknown as
      | ConnectionRow
      | undefined;
    return row ? toConnection(row) : undefined;
  }

  upsertConnection(record: ConnectionRecord): void {
    this.db
      .prepare(
        `INSERT INTO connections
         (id, type, provider, kind, consumption, model, alias, enabled, permission, secret_ref, fallback_ids, options, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, provider=excluded.provider, kind=excluded.kind, consumption=excluded.consumption,
           model=excluded.model, alias=excluded.alias, enabled=excluded.enabled, permission=excluded.permission,
           secret_ref=excluded.secret_ref, fallback_ids=excluded.fallback_ids, options=excluded.options,
           updated_at=excluded.updated_at`,
      )
      .run(
        record.id,
        record.type,
        record.provider,
        record.kind,
        record.consumption,
        record.model,
        record.alias,
        record.enabled ? 1 : 0,
        record.permission,
        record.secret_ref,
        JSON.stringify(record.fallback_ids),
        JSON.stringify(record.options),
        record.created_at,
        record.updated_at,
      );
  }

  setConnectionEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE connections SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
  }

  deleteConnection(id: string): void {
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
  }

  // --- gateway keys ---

  listKeys(): Array<{ id: string; label: string; created_at: string; last_used_at: string | null }> {
    const rows = this.db.prepare("SELECT * FROM gateway_keys ORDER BY created_at").all() as unknown as KeyRow[];
    return rows.map((r) => ({ id: r.id, label: r.label, created_at: r.created_at, last_used_at: r.last_used_at }));
  }

  /** Returns the stored digest for a candidate hash so the caller can confirm it in constant time. */
  findKeyByHash(hash: string): { id: string; label: string; keyHash: string } | undefined {
    const row = this.db.prepare("SELECT id, label, key_hash FROM gateway_keys WHERE key_hash = ?").get(hash) as unknown as
      | KeyRow
      | undefined;
    return row ? { id: row.id, label: row.label, keyHash: row.key_hash } : undefined;
  }

  addKey(id: string, label: string, keyHash: string): void {
    this.db
      .prepare("INSERT INTO gateway_keys (id, label, key_hash, created_at) VALUES (?,?,?,?)")
      .run(id, label, keyHash, new Date().toISOString());
  }

  touchKey(id: string): void {
    this.db
      .prepare("UPDATE gateway_keys SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  removeKey(id: string): void {
    this.db.prepare("DELETE FROM gateway_keys WHERE id = ?").run(id);
  }

  // --- settings ---

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as unknown as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
  }

  // --- events (content-free) ---

  recordEvent(event: {
    request_id: string;
    connection_id: string;
    route: string;
    consumption: string;
    model_confidence: string;
    outcome: string;
    duration_ms: number;
    bytes_in?: number;
    bytes_out?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events
         (ts, request_id, connection_id, route, consumption, model_confidence, outcome, duration_ms, bytes_in, bytes_out)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        event.request_id,
        event.connection_id,
        event.route,
        event.consumption,
        event.model_confidence,
        event.outcome,
        event.duration_ms,
        event.bytes_in ?? null,
        event.bytes_out ?? null,
      );
  }

  /** Prompt and response text is never stored, so there is nothing sensitive to expire here. */
  pruneEvents(now = Date.now()): number {
    const cutoff = new Date(now - EVENT_RETENTION_MS).toISOString();
    const result = this.db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  countEventsFor(connectionId: string, sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE connection_id = ? AND ts >= ?")
      .get(connectionId, sinceIso) as unknown as { n: number };
    return Number(row?.n ?? 0);
  }

  /** Newest first. Content-free by construction: this table has no column for text. */
  recentEvents(limit = 20): Array<{
    ts: string;
    request_id: string;
    connection_id: string;
    route: string;
    consumption: string;
    model_confidence: string;
    outcome: string;
    duration_ms: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT ts, request_id, connection_id, route, consumption, model_confidence, outcome, duration_ms
         FROM events ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      ts: String(r.ts),
      request_id: String(r.request_id),
      connection_id: String(r.connection_id),
      route: String(r.route),
      consumption: String(r.consumption),
      model_confidence: String(r.model_confidence),
      outcome: String(r.outcome),
      duration_ms: Number(r.duration_ms),
    }));
  }
}

function toConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    type: row.type as ConnectionType,
    provider: row.provider,
    kind: row.kind as ConnectionRecord["kind"],
    consumption: row.consumption as ConnectionRecord["consumption"],
    model: row.model,
    alias: row.alias,
    enabled: row.enabled === 1,
    permission: row.permission as ConnectionRecord["permission"],
    secret_ref: row.secret_ref,
    fallback_ids: parseJson<string[]>(row.fallback_ids, []),
    options: parseJson<ConnectionRecord["options"]>(row.options, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
