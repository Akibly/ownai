import { describe, expect, it } from "vitest";
import {
  KeyringSecretStore,
  LEGACY_SECRET_SERVICES,
  SECRET_SERVICE,
  type SecretEntry,
} from "../src/secrets.ts";

/** A fake vault, because the real one is the owner's Windows credential store. */

class FakeVault {
  readonly entries = new Map<string, string>();
  readonly migrations: string[] = [];

  read(service: string, account: string): string | null {
    return this.entries.get(`${service}/${account}`) ?? null;
  }

  seed(service: string, account: string, value: string): void {
    this.entries.set(`${service}/${account}`, value);
  }

  entry(): (service: string, account: string) => SecretEntry {
    const vault = this;
    return (service, account) => ({
      getPassword: () => vault.read(service, account),
      setPassword: (value) => void vault.entries.set(`${service}/${account}`, value),
      deletePassword: () => vault.entries.delete(`${service}/${account}`),
    });
  }

  store(): KeyringSecretStore {
    return new KeyringSecretStore({
      entries: this.entry(),
      onMigrated: (ref) => this.migrations.push(ref),
    });
  }
}

describe("credential service rename", () => {
  it("copies a secret found under a legacy service name and removes the old entry", async () => {
    const vault = new FakeVault();
    vault.seed("byoai-bridge", "gateway-key:abc", "sk-local-oldvalue");

    const store = vault.store();
    await expect(store.get("gateway-key:abc")).resolves.toBe("sk-local-oldvalue");

    expect(vault.read(SECRET_SERVICE, "gateway-key:abc")).toBe("sk-local-oldvalue");
    for (const legacy of LEGACY_SECRET_SERVICES) expect(vault.read(legacy, "gateway-key:abc")).toBeNull();
    expect(vault.migrations).toEqual(["gateway-key:abc"]);
  });

  it("leaves the old entry in place when the copy could not be written", async () => {
    const vault = new FakeVault();
    vault.seed("byo-ai-bridge", "provider-key:x", "secret");
    const writable = new KeyringSecretStore({
      entries: (service, account) => ({
        getPassword: () => vault.read(service, account),
        setPassword: () => {
          throw new Error("vault refused");
        },
        deletePassword: () => vault.entries.delete(`${service}/${account}`),
      }),
    });

    await expect(writable.get("provider-key:x")).rejects.toThrow("vault refused");
    // The one thing that must survive a failed migration is the secret itself.
    expect(vault.read("byo-ai-bridge", "provider-key:x")).toBe("secret");
  });

  it("deletes every service name, so a revoked key cannot come back from the past", async () => {
    const vault = new FakeVault();
    vault.seed(SECRET_SERVICE, "gateway-key:abc", "current");
    vault.seed("byoai-bridge", "gateway-key:abc", "old-copy");

    const store = vault.store();
    await store.delete("gateway-key:abc");
    expect(vault.read(SECRET_SERVICE, "gateway-key:abc")).toBeNull();
    // A resurrection would be an ADR-011 revocation failure, not a cosmetic leak.
    await expect(store.get("gateway-key:abc")).resolves.toBeNull();
  });

  it("writes new secrets only under the current service", async () => {
    const vault = new FakeVault();
    const store = vault.store();
    await store.set("provider-key:groq", "gsk_new");

    expect(vault.read(SECRET_SERVICE, "provider-key:groq")).toBe("gsk_new");
    for (const legacy of LEGACY_SECRET_SERVICES) expect(vault.read(legacy, "provider-key:groq")).toBeNull();
  });

  it("prefers the current entry and does not report a migration", async () => {
    const vault = new FakeVault();
    vault.seed(SECRET_SERVICE, "gateway-key:abc", "current");
    vault.seed("byoai-bridge", "gateway-key:abc", "stale");

    const store = vault.store();
    await expect(store.get("gateway-key:abc")).resolves.toBe("current");
    expect(vault.migrations).toEqual([]);
  });
});
