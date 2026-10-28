import type { DatabaseSync } from "node:sqlite";

/** Content-free request metadata. There is deliberately no column for prompts or replies. */
export interface RequestEvent {
  request_id: string;
  connection_id: string | null;
  status: "ok" | "error";
  error_code: string | null;
  duration_ms: number;
  route_changed: boolean;
  streamed: boolean;
}

export class EventsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly retentionDays: number,
  ) {}

  record(e: RequestEvent): void {
    if (this.retentionDays === 0) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO request_events
           (request_id, ts, connection_id, status, error_code, duration_ms, route_changed, streamed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.request_id,
        new Date().toISOString(),
        e.connection_id,
        e.status,
        e.error_code,
        Math.round(e.duration_ms),
        e.route_changed ? 1 : 0,
        e.streamed ? 1 : 0,
      );
  }

  recent(limit = 100): Array<RequestEvent & { ts: string }> {
    return (
      this.db.prepare("SELECT * FROM request_events ORDER BY ts DESC LIMIT ?").all(limit) as Array<
        Record<string, unknown>
      >
    ).map((r) => ({
      request_id: r.request_id as string,
      ts: r.ts as string,
      connection_id: r.connection_id as string | null,
      status: r.status as "ok" | "error",
      error_code: r.error_code as string | null,
      duration_ms: r.duration_ms as number,
      route_changed: r.route_changed === 1,
      streamed: r.streamed === 1,
    }));
  }

  purgeExpired(): number {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM request_events WHERE ts < ?").run(cutoff).changes);
  }
}
