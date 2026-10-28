import type { PermissionStatus } from "@ownai/contracts";
import type { DatabaseSync } from "node:sqlite";

export interface ConnectionRecord {
  /** Slug used as the model-ID prefix: "<id>/<model>". */
  id: string;
  adapter_type: string;
  display_name: string;
  enabled: boolean;
  permission_status: PermissionStatus;
  /** Where the permission is documented (URL or internal record ID). */
  permission_ref: string | null;
  /** Whether requests through this connection can cost the user money. */
  paid: boolean;
  max_concurrency: number;
  max_queue: number;
  settings: Record<string, unknown>;
  /** Keychain account name holding this connection's secret, if any. Never the secret itself. */
  secret_ref: string | null;
}

interface Row {
  id: string;
  adapter_type: string;
  display_name: string;
  enabled: number;
  permission_status: PermissionStatus;
  permission_ref: string | null;
  paid: number;
  max_concurrency: number;
  max_queue: number;
  settings_json: string;
  secret_ref: string | null;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

function fromRow(r: Row): ConnectionRecord {
  return {
    id: r.id,
    adapter_type: r.adapter_type,
    display_name: r.display_name,
    enabled: r.enabled === 1,
    permission_status: r.permission_status,
    permission_ref: r.permission_ref,
    paid: r.paid === 1,
    max_concurrency: r.max_concurrency,
    max_queue: r.max_queue,
    settings: JSON.parse(r.settings_json) as Record<string, unknown>,
    secret_ref: r.secret_ref,
  };
}

export class ConnectionsStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): ConnectionRecord[] {
    return (this.db.prepare("SELECT * FROM connections ORDER BY created_at, id").all() as unknown as Row[]).map(
      fromRow,
    );
  }

  get(id: string): ConnectionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as unknown as Row | undefined;
    return row && fromRow(row);
  }

  upsert(rec: ConnectionRecord): void {
    if (!ID_PATTERN.test(rec.id)) throw new Error(`Invalid connection id "${rec.id}"`);
    this.db
      .prepare(
        `INSERT INTO connections (id, adapter_type, display_name, enabled, permission_status, permission_ref,
           paid, max_concurrency, max_queue, settings_json, secret_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET adapter_type = excluded.adapter_type, display_name = excluded.display_name,
           enabled = excluded.enabled, permission_status = excluded.permission_status,
           permission_ref = excluded.permission_ref, paid = excluded.paid, max_concurrency = excluded.max_concurrency,
           max_queue = excluded.max_queue, settings_json = excluded.settings_json, secret_ref = excluded.secret_ref`,
      )
      .run(
        rec.id,
        rec.adapter_type,
        rec.display_name,
        rec.enabled ? 1 : 0,
        rec.permission_status,
        rec.permission_ref,
        rec.paid ? 1 : 0,
        rec.max_concurrency,
        rec.max_queue,
        JSON.stringify(rec.settings),
        rec.secret_ref,
        new Date().toISOString(),
      );
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.db.prepare("UPDATE connections SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes > 0;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM connections WHERE id = ?").run(id).changes > 0;
  }
}
