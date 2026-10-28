import { existsSync, cpSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * OwnAI was called "BYO AI Bridge" until the owner renamed it. Two locations carry
 * that old name — the data directory and the `BRIDGE_*` environment variables — and
 * neither can be silently dropped: the directory holds the connection records and
 * the profile pointers, and a dropped `BRIDGE_PORT` would quietly change the port.
 *
 * The migration copies; it never deletes. Once the copy is verified the old
 * directory is marked so it is never migrated twice, and removing it stays the
 * owner's decision.
 */

/** Every place the pre-rename OwnAI could have put its data. */
export function legacyDataDirs(): string[] {
  const local = process.platform === "win32" && process.env.LOCALAPPDATA;
  return [
    join(process.cwd(), ".bridge-data"),
    join(process.cwd(), ".byo-ai-bridge"),
    local ? join(process.env.LOCALAPPDATA!, "BYO AI Bridge") : join(homedir(), ".byo-ai-bridge"),
  ];
}

/** Reads `OWNAI_*`, falling back to the old `BRIDGE_*` spelling, which is reported once. */
const legacyEnvUsed = new Set<string>();

export function envValue(name: string): string | undefined {
  const own = process.env[name];
  if (own !== undefined && own !== "") return own;
  const legacy = name.replace(/^OWNAI_/, "BRIDGE_");
  const old = process.env[legacy];
  if (old !== undefined && old !== "") {
    legacyEnvUsed.add(`${legacy} (now ${name})`);
    return old;
  }
  return undefined;
}

export function legacyEnvNotice(): string | null {
  if (legacyEnvUsed.size === 0) return null;
  return `Using renamed environment variables: ${[...legacyEnvUsed].join(", ")}.`;
}

function hasData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => name.endsWith(".sqlite") || name === "browser-profiles");
}

/**
 * Copies the first legacy directory that actually holds data into `target`.
 * Returns the source it migrated from, or null when there is nothing to do.
 */
export function migrateLegacyDataDir(target: string, sources = legacyDataDirs()): string | null {
  if (hasData(target)) return null; // Already ownai's own data.
  for (const source of sources) {
    if (!hasData(source)) continue;
    checkpointWal(source);
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    verifyCopy(source, target);
    writeFileSync(join(source, "MIGRATED-TO-OWNAI.txt"), `${target}\n`, "utf8");
    return source;
  }
  return null;
}

/**
 * A WAL left next to a copied database is a corrupt database. Checkpoint first so
 * the copy is one self-contained file. Failures are not fatal: the copy below still
 * takes every file, and an unopenable store will surface in its own error.
 */
function checkpointWal(dir: string): void {
  const file = join(dir, "bridge.sqlite");
  if (!existsSync(file)) return;
  try {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
  } catch {
    // The store is open elsewhere, or the file is not a database. Copy as it is.
  }
}

function verifyCopy(source: string, target: string): void {
  for (const entry of readdirSync(source)) {
    if (entry === "MIGRATED-TO-OWNAI.txt") continue;
    const from = join(source, entry);
    const to = join(target, entry);
    if (!existsSync(to)) throw new Error(`Migration check failed: ${entry} did not reach ${target}.`);
    if (!statSync(from).isFile() || !statSync(to).isFile()) continue;
    if (statSync(from).size !== statSync(to).size) {
      throw new Error(`Migration check failed: ${entry} copied with a different size.`);
    }
  }
}
