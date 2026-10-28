import { describe, expect, it } from "vitest";
import { hashGatewayKey, newGatewayKey } from "../src/auth.ts";
import { createRuntime } from "../src/runtime.ts";
import { BridgeStore } from "../src/stores/store.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { chatRequest, makeHarness } from "./helpers.ts";

/** T02, T08 and the loopback transport rules (FR-03, SEC-L1, SEC-L2). */
describe("loopback auth and origin", () => {
  it("allows an authenticated console request but rejects a different local origin", async () => {
    const harness = await makeHarness();
    try {
      expect((await harness.post(chatRequest("mock"), { origin: "http://127.0.0.1:8791" })).statusCode).toBe(200);
      expect((await harness.post(chatRequest("mock"), { origin: "http://127.0.0.1:8792" })).statusCode).toBe(403);
      const anonymous = await harness.app.inject({
        method: "POST", url: "/v1/chat/completions", payload: chatRequest("mock"),
        headers: { host: "127.0.0.1:8791", origin: "http://127.0.0.1:8791" },
      });
      expect(anonymous.statusCode).toBe(401);
    } finally { await harness.app.close(); }
  });

  it("T02: no key means no generation, even from loopback", async () => {
    const harness = await makeHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { host: "127.0.0.1:8791" },
      payload: chatRequest("mock"),
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_api_key");
    await harness.app.close();
  });

  it("T02b: a wrong key is rejected the same way, with no hint about the real one", async () => {
    const harness = await makeHarness();
    const res = await harness.get("/v1/models", { authorization: "Bearer sk-ownai-not-a-real-key" });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.message).toBe("Gateway key not recognised.");
    await harness.app.close();
  });

  it("ADR-019: a key minted under the old label still authenticates", async () => {
    expect(newGatewayKey().startsWith("sk-ownai-")).toBe(true);
    const harness = await makeHarness();
    // Authentication is a digest lookup, so the rename cannot orphan a key the owner
    // already pasted into a client. It stays valid until its row is removed.
    const legacy = `sk-local-${"a".repeat(43)}`;
    harness.store.addKey("legacy-key", "test", hashGatewayKey(legacy));
    expect((await harness.get("/v1/models", { authorization: `Bearer ${legacy}` })).statusCode).toBe(200);
    await harness.app.close();
  });

  it("T08: a browser Origin the user never allowlisted is refused", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("mock"), { Origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("forbidden_origin");
    await harness.app.close();
  });

  it("T08b: an allowlisted origin is accepted", async () => {
    const harness = await makeHarness({ originAllowlist: ["tauri://localhost"] });
    const res = await harness.post(chatRequest("mock"), { Origin: "tauri://localhost" });
    expect(res.statusCode).toBe(200);
    await harness.app.close();
  });

  it("SEC-L2: a non-loopback Host is refused, which is what defeats DNS rebinding", async () => {
    const harness = await makeHarness();
    const res = await harness.get("/v1/models", { host: "attacker.example:8791" });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("forbidden_origin");
    await harness.app.close();
  });

  it("SEC-L2b: a Host pointing at another local port is refused", async () => {
    const harness = await makeHarness();
    const res = await harness.get("/v1/models", { host: "127.0.0.1:9999" });
    expect(res.statusCode).toBe(403);
    await harness.app.close();
  });

  it("sends no CORS headers, so no cross-site reader can consume a response", async () => {
    const harness = await makeHarness();
    const res = await harness.get("/v1/models");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await harness.app.close();
  });

  it("health is reachable without a key but still only over a loopback Host", async () => {
    const harness = await makeHarness();
    expect((await harness.get("/health")).statusCode).toBe(200);
    const foreign = await harness.get("/health", { host: "evil.example:8791" });
    expect(foreign.statusCode).toBe(403);
    await harness.app.close();
  });

  it("FR-03b: rotating the gateway key revokes the previous one everywhere", async () => {
    const store = BridgeStore.inMemory();
    const runtime = createRuntime({ store, secrets: new MemorySecretStore() });
    try {
      const first = await runtime.ensureGatewayKey();
      const next = await runtime.rotateGatewayKey();

      expect(next.plaintext).not.toBe(first.plaintext);
      expect(next.retired).toEqual([first.id]);
      // authorize() resolves a request by digest on every call, so a missing row is
      // the 401 — no running server has to be restarted for revocation to take hold.
      expect(store.findKeyByHash(hashGatewayKey(first.plaintext!))).toBeUndefined();
      expect(store.findKeyByHash(hashGatewayKey(next.plaintext))?.id).toBe(next.id);
      expect(store.listKeys().map((entry) => entry.id)).toEqual([next.id]);
      expect(await runtime.revealGatewayKey(next.id)).toBe(next.plaintext);
      expect(await runtime.revealGatewayKey(first.id)).toBeNull();
    } finally {
      await runtime.close();
    }
  });
});
