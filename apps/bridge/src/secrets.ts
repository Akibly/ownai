/**
 * ADR-010: provider API keys, OAuth refresh tokens and the gateway key's plaintext
 * live in the OS credential store. SQLite holds a reference and a hash, never a
 * secret. The in-memory store exists for tests and is refused in production builds.
 */

export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export const SECRET_SERVICE = "ownai";

/** Vault reference for one connection's provider key. SQLite stores this, never the key. */
export const providerKeyRef = (connectionId: string): string => `provider-key:${connectionId}`;

/**
 * Names this product stored secrets under before it was called OwnAI. Read once and
 * copied forward, then deleted.
 */
export const LEGACY_SECRET_SERVICES: readonly string[] = ["byoai-bridge", "byo-ai-bridge"];

/** The slice of @napi-rs/keyring this store needs, so tests can fake the vault. */
export interface SecretEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

export type EntryFactory = (service: string, account: string) => SecretEntry;

export interface KeyringOptions {
  entries?: EntryFactory;
  /** Called when an entry is found under a legacy service name and copied forward. */
  onMigrated?: (ref: string) => void;
}

export class KeyringSecretStore implements SecretStore {
  constructor(private readonly options: KeyringOptions = {}) {}

  private async entryFactory(): Promise<EntryFactory> {
    if (this.options.entries) return this.options.entries;
    const { Entry } = await import("@napi-rs/keyring");
    return (service, account) => new Entry(service, account);
  }

  async get(ref: string): Promise<string | null> {
    const entry = await this.entryFactory();
    const current = entry(SECRET_SERVICE, ref).getPassword();
    if (current !== null) return current;

    for (const legacy of LEGACY_SECRET_SERVICES) {
      const value = entry(legacy, ref).getPassword();
      if (value === null) continue;
      entry(SECRET_SERVICE, ref).setPassword(value);
      // Only drop the old entry once the copy is confirmed readable, so a failed
      // write cannot leave the owner with no secret anywhere.
      if (entry(SECRET_SERVICE, ref).getPassword() === value) {
        entry(legacy, ref).deletePassword();
        this.options.onMigrated?.(ref);
      }
      return value;
    }
    return null;
  }

  async set(ref: string, value: string): Promise<void> {
    const entry = await this.entryFactory();
    entry(SECRET_SERVICE, ref).setPassword(value);
  }

  /**
   * Every service name, not just the current one. Revocation has to be total: if a
   * legacy copy survived a delete, the next get() would find it, copy it forward and
   * hand a revoked key back to the world (ADR-011).
   */
  async delete(ref: string): Promise<void> {
    const entry = await this.entryFactory();
    entry(SECRET_SERVICE, ref).deletePassword();
    for (const legacy of LEGACY_SECRET_SERVICES) entry(legacy, ref).deletePassword();
  }
}

export function defaultSecretStore(options: KeyringOptions = {}): SecretStore {
  return new KeyringSecretStore(options);
}

export class MemorySecretStore implements SecretStore {
  readonly kind = "test-only" as const;
  private readonly values = new Map<string, string>();

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}
