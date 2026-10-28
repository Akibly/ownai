import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BridgeStore } from "../src/stores/store.ts";

/**
 * The daily limit is a guard on the account's own allowance. It has to survive a
 * database written before turns were distinguished from attempts.
 */
describe("turn accounting", () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  const base = {
    connection_id: "claude-web",
    route: "A",
    consumption: "free_quota",
    model_confidence: "unknown",
    outcome: "provider_unavailable",
    duration_ms: 4,
  };

  it("logs an attempt that never reached the provider without charging a turn", () => {
    const store = BridgeStore.inMemory();

    store.recordEvent({ ...base, request_id: "free", spent_turn: false });
    expect(store.countEventsFor("claude-web", since)).toBe(1);
    expect(store.countTurnsFor("claude-web", since)).toBe(0);

    store.recordEvent({ ...base, request_id: "paid", outcome: "ok", spent_turn: true });
    expect(store.countTurnsFor("claude-web", since)).toBe(1);
    store.close();
  });

  it("adds the turn column to a database written before it existed", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ownai-store-")), "bridge.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY, ts TEXT NOT NULL, request_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      route TEXT NOT NULL, consumption TEXT NOT NULL, model_confidence TEXT NOT NULL, outcome TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, bytes_in INTEGER, bytes_out INTEGER
    )`);
    legacy
      .prepare("INSERT INTO events VALUES (1,?,?,?,?,?,?,?,?,?,?)")
      .run(new Date().toISOString(), "old", "claude-web", "A", "free_quota", "unknown", "ok", 1, null, null);
    legacy.close();

    const store = BridgeStore.open(file);
    // Rows written before the distinction count as spent: the limit is never loosened
    // by upgrading.
    expect(store.countTurnsFor("claude-web", since)).toBe(1);
    store.close();
  });
});
