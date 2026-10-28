import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { envValue, legacyEnvNotice, migrateLegacyDataDir } from "../src/migrate.ts";

/** The rename from "BYO AI Bridge" to OwnAI has to move real data, not just strings. */

const roots: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ownai-migrate-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OWNAI_WIDGET;
  delete process.env.BRIDGE_WIDGET;
});

function storeWithRows(file: string, rows: number): void {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE t (n INTEGER);");
  db.exec("BEGIN");
  for (let i = 0; i < rows; i += 1) db.prepare("INSERT INTO t VALUES (?)").run(i);
  db.exec("COMMIT");
  db.close();
}

function readRows(file: string): number {
  const db = new DatabaseSync(file);
  try {
    return Number(db.prepare("SELECT count(*) AS c FROM t").get()?.["c"] ?? 0);
  } finally {
    db.close();
  }
}

describe("data directory migration", () => {
  it("copies the old directory and leaves it in place", () => {
    const root = workspace();
    const source = join(root, ".bridge-data");
    const target = join(root, "OwnAI");
    mkdirSync(join(source, "browser-profiles"), { recursive: true });
    writeFileSync(join(source, "browser-profiles", "note.txt"), "profile", "utf8");
    storeWithRows(join(source, "bridge.sqlite"), 3);

    expect(migrateLegacyDataDir(target, [source, join(root, "missing")])).toBe(source);
    expect(readRows(join(target, "bridge.sqlite"))).toBe(3);
    expect(readFileSync(join(target, "browser-profiles", "note.txt"), "utf8")).toBe("profile");
    // The owner's decision to delete the old folder stays the owner's.
    expect(existsSync(join(source, "bridge.sqlite"))).toBe(true);
    expect(readFileSync(join(source, "MIGRATED-TO-OWNAI.txt"), "utf8")).toContain(target);
  });

  it("checkpoints the write-ahead log, because a copied WAL is a corrupt database", () => {
    const root = workspace();
    const source = join(root, ".bridge-data");
    const target = join(root, "OwnAI");
    mkdirSync(source, { recursive: true });
    storeWithRows(join(source, "bridge.sqlite"), 5);
    // journal_mode=WAL leaves a -wal behind; drop the side files so only the main
    // database can carry those rows across.
    rmSync(join(source, "bridge.sqlite-wal"), { force: true });
    rmSync(join(source, "bridge.sqlite-shm"), { force: true });

    migrateLegacyDataDir(target, [source]);
    expect(readRows(join(target, "bridge.sqlite"))).toBe(5);
  });

  it("does nothing once the target holds data, and nothing when no legacy directory exists", () => {
    const root = workspace();
    const source = join(root, ".bridge-data");
    const target = join(root, "OwnAI");
    mkdirSync(source, { recursive: true });
    storeWithRows(join(source, "bridge.sqlite"), 1);

    expect(migrateLegacyDataDir(target, [source])).toBe(source);
    expect(migrateLegacyDataDir(target, [source])).toBeNull();
    expect(migrateLegacyDataDir(join(root, "elsewhere"), [join(root, "nothing-here")])).toBeNull();
  });

  it("reads OWNAI_* first and says so when it falls back to BRIDGE_*", () => {
    process.env.BRIDGE_WIDGET = "8787";
    expect(envValue("OWNAI_WIDGET")).toBe("8787");
    expect(legacyEnvNotice()).toContain("BRIDGE_WIDGET (now OWNAI_WIDGET)");

    process.env.OWNAI_WIDGET = "8791";
    expect(envValue("OWNAI_WIDGET")).toBe("8791");

    delete process.env.BRIDGE_WIDGET;
    delete process.env.OWNAI_WIDGET;
    expect(envValue("OWNAI_WIDGET")).toBeUndefined();
  });
});
