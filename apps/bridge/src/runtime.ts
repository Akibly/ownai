import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ConnectionRecord } from "@ownai/contracts";
import { AdapterRegistry } from "./registry.ts";
import { BridgeStore } from "./stores/store.ts";
import { Router } from "./router.ts";
import { hashGatewayKey, newGatewayKey } from "./auth.ts";
import { defaultSecretStore, SECRET_SERVICE, type SecretStore } from "./secrets.ts";
import { loadConfig } from "./config.ts";
import { migrateLegacyDataDir } from "./migrate.ts";

/** Shared wiring for the CLI, the server and the tests, so they cannot drift apart. */

export interface RuntimeOptions {
  /** Root for SQLite and browser profiles. Defaults to the platform OwnAI data directory. */
  dataDir?: string;
  port?: number;
  /** Injected in tests; production uses the OS keychain (ADR-010). */
  secrets?: SecretStore;
  store?: BridgeStore;
  connectors?: ConstructorParameters<typeof AdapterRegistry>[0]["connectors"];
  /** One-time things the owner should hear about: a data migration, a renamed env var. */
  onNotice?: (message: string) => void;
  /** Move data left by the pre-rename default. Only the CLI sets this. */
  migrateDataDir?: boolean;
}

export interface Runtime {
  dataDir: string;
  port: number;
  store: BridgeStore;
  registry: AdapterRegistry;
  router: Router;
  secrets: SecretStore;
  /** Ensures a gateway key exists. Returns the plaintext only when it was just created. */
  ensureGatewayKey(): Promise<{ id: string; created: boolean; plaintext?: string }>;
  /**
   * Mints a replacement key and revokes every other digest, so a key that has been
   * printed somewhere untrustworthy stops authorising. The plaintext of the retired
   * keys is scrubbed best-effort: revocation comes from the digest row, never from it.
   */
  rotateGatewayKey(): Promise<{ id: string; plaintext: string; retired: string[]; unscrubbed: string[] }>;
  revealGatewayKey(id?: string): Promise<string | null>;
  saveConnection(record: ConnectionRecord): void;
  close(): Promise<void>;
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const dataDir = options.dataDir ?? loadConfig().dataDir;
  // Opt-in so only the operator's CLI ever moves files. A test injecting an
  // in-memory store must never touch the owner's real directories.
  if (options.migrateDataDir === true && options.dataDir === undefined) {
    const from = migrateLegacyDataDir(dataDir);
    if (from) options.onNotice?.(`Data migrated from ${from} to ${dataDir}. The old folder is left where it was.`);
  }
  const port = options.port ?? loadConfig().port;
  const store = options.store ?? openStore(dataDir);
  const secrets =
    options.secrets ??
    defaultSecretStore({
      onMigrated: (ref) => options.onNotice?.(`Moved the stored secret "${ref}" into the ${SECRET_SERVICE} credential service.`),
    });
  const registry = new AdapterRegistry({
    dataDir,
    secrets,
    ...(options.connectors ? { connectors: options.connectors } : {}),
  });
  const router = new Router({ store, registry });

  store.pruneEvents();

  return {
    dataDir,
    port,
    store,
    registry,
    router,
    secrets,

    async ensureGatewayKey() {
      const existing = store.listKeys();
      if (existing.length > 0) return { id: existing[0]!.id, created: false };
      const id = randomUUID();
      const plaintext = newGatewayKey();
      store.addKey(id, "local", hashGatewayKey(plaintext));
      await secrets.set(keyRef(id), plaintext);
      return { id, created: true, plaintext };
    },

    async rotateGatewayKey() {
      const stale = store.listKeys();
      const id = randomUUID();
      const plaintext = newGatewayKey();
      // Written first, so an interruption can never leave the device without a key.
      store.addKey(id, "local", hashGatewayKey(plaintext));
      await secrets.set(keyRef(id), plaintext);

      const unscrubbed: string[] = [];
      for (const entry of stale) {
        store.removeKey(entry.id);
        try {
          await secrets.delete(keyRef(entry.id));
        } catch {
          unscrubbed.push(entry.id);
        }
      }
      return { id, plaintext, retired: stale.map((entry) => entry.id), unscrubbed };
    },

    async revealGatewayKey(id) {
      const target = id ?? store.listKeys()[0]?.id;
      if (!target) return null;
      return secrets.get(keyRef(target));
    },

    saveConnection(record) {
      store.upsertConnection(record);
    },

    async close() {
      await registry.closeAll();
      store.close();
    },
  };
}

function openStore(dataDir: string): BridgeStore {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return BridgeStore.open(join(dataDir, "bridge.sqlite"));
}

const keyRef = (id: string) => `gateway-key:${id}`;
