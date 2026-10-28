import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const KEY_PREFIX = "byoai_local_";

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

function hashKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Local gateway keys. Only SHA-256 hashes are stored; keys are 256-bit random,
 * so an unsalted fast hash is sufficient (no dictionary to attack).
 */
export class ApiKeyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Stores a new key and returns its record. The caller is responsible for showing the key once. */
  add(key: string): ApiKeyRecord {
    const record: ApiKeyRecord = {
      id: randomUUID(),
      prefix: key.slice(0, KEY_PREFIX.length + 4),
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.db
      .prepare("INSERT INTO api_keys (id, hash, prefix, created_at) VALUES (?, ?, ?, ?)")
      .run(record.id, hashKey(key), record.prefix, record.created_at);
    return record;
  }

  verify(candidate: string): boolean {
    if (!candidate.startsWith(KEY_PREFIX) || candidate.length > 200) return false;
    const h = hashKey(candidate);
    const rows = this.db.prepare("SELECT hash FROM api_keys WHERE revoked_at IS NULL").all() as Array<{
      hash: Uint8Array;
    }>;
    let ok = false;
    for (const row of rows) {
      // Compare against every row so timing does not reveal which key matched.
      if (timingSafeEqual(Buffer.from(row.hash), h)) ok = true;
    }
    return ok;
  }

  list(): ApiKeyRecord[] {
    return this.db
      .prepare("SELECT id, prefix, created_at, revoked_at FROM api_keys ORDER BY created_at")
      .all() as unknown as ApiKeyRecord[];
  }

  hasActive(): boolean {
    return this.db.prepare("SELECT 1 FROM api_keys WHERE revoked_at IS NULL LIMIT 1").get() !== undefined;
  }

  revokeAll(): void {
    this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE revoked_at IS NULL").run(new Date().toISOString());
  }
}
