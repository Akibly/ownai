import { describe, expect, it } from "vitest";
import { BridgeError, type ConnectionRecord } from "@ownai/contracts";
import { claudeConnection, mockConnection } from "../src/connections.ts";
import { TurnBudget, assertTrafficAllowed } from "../src/policy.ts";
import { chatRequest, makeHarness, mockAdapterFor, recordOf } from "./helpers.ts";

/** T05, T15, T18: error normalization, consent-only fallback, and the permission gate. */

function withOverrides(record: ConnectionRecord, over: Partial<ConnectionRecord>): ConnectionRecord {
  return { ...record, ...over };
}

describe("router", () => {
  it("accepts every advertised model name when a connection has a different alias", async () => {
    const harness = await makeHarness({ connections: [{ ...mockConnection("internal-id"), alias: "friendly" }] });
    try {
      const models = await harness.get("/v1/models");
      expect(models.body.data.map((entry: { id: string }) => entry.id)).toEqual(["friendly", "friendly/mock-echo"]);
      for (const entry of models.body.data) {
        const response = await harness.post(chatRequest(entry.id));
        expect(response.statusCode).toBe(200);
        expect(response.body.bridge.connection_id).toBe("internal-id");
        expect(response.body.bridge.provider_model).toBe("mock-echo");
      }
      expect((await harness.post(chatRequest("friendly/not-configured"))).statusCode).toBe(404);
    } finally { await harness.app.close(); }
  });

  it("accepts n: 1 and empty tools without treating them as sampling parameters", async () => {
    const harness = await makeHarness();
    try {
      expect((await harness.post(chatRequest("mock", "hello", { n: 1, tools: [] }))).statusCode).toBe(200);
      expect((await harness.post(chatRequest("mock", "hello", { n: 2 }))).body.error.code).toBe("unsupported_feature");
    } finally { await harness.app.close(); }
  });

  it("T05: a provider-side quota failure surfaces as 429 quota_exhausted", async () => {
    const harness = await makeHarness();
    const record = recordOf(harness, "mock");
    const adapter = await mockAdapterFor(harness, record);
    adapter.failWith = "quota_exhausted";

    const res = await harness.post(chatRequest("mock"));
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe("quota_exhausted");
    // A quota refusal is not a credential refusal; a client must not hunt for a bad key.
    expect(res.body.error.type).toBe("rate_limit_error");
    await harness.app.close();
  });

  it("T05b: a provider login expiry is 409, not 401 (ADR-013)", async () => {
    const harness = await makeHarness();
    const adapter = await mockAdapterFor(harness, recordOf(harness, "mock"));
    adapter.failWith = "login_required";

    const res = await harness.post(chatRequest("mock"));
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("login_required");
    await harness.app.close();
  });

  it("T15: an unapproved paid connection is never used as a fallback", async () => {
    const paid = withOverrides(mockConnection("paid"), {
      provider: "Paid API",
      alias: "paid",
      consumption: "paid_credits",
    });
    const harness = await makeHarness({ connections: [mockConnection("primary"), paid] });
    const paidAdapter = await mockAdapterFor(harness, recordOf(harness, "paid"));
    const failing = await mockAdapterFor(harness, recordOf(harness, "primary"));
    failing.failWith = "provider_unavailable";

    const res = await harness.post(chatRequest("primary"));
    expect(res.statusCode).toBe(503);
    expect(paidAdapter.calls).toBe(0);
    await harness.app.close();
  });

  it("T15b: an approved fallback is used and the change is labelled, never hidden", async () => {
    const primary = withOverrides(mockConnection("primary"), { fallback_ids: ["paid"] });
    const paid = withOverrides(mockConnection("paid"), { consumption: "paid_credits" });
    const harness = await makeHarness({ connections: [primary, paid] });
    const paidAdapter = await mockAdapterFor(harness, recordOf(harness, "paid"));
    const failing = await mockAdapterFor(harness, recordOf(harness, "primary"));
    failing.failWith = "provider_unavailable";

    const res = await harness.post(chatRequest("primary"));
    expect(res.statusCode).toBe(200);
    expect(paidAdapter.calls).toBe(1);
    expect(res.body.bridge.route_changed).toBe(true);
    expect(res.body.bridge.consumption).toBe("paid_credits");
    expect(res.body.bridge.connection_id).toBe("paid");
    await harness.app.close();
  });

  it("T15c: a prompt that may have reached the provider is never re-sent elsewhere", async () => {
    const primary = withOverrides(mockConnection("primary"), { fallback_ids: ["paid"] });
    const paid = withOverrides(mockConnection("paid"), { consumption: "paid_credits" });
    const harness = await makeHarness({ connections: [primary, paid] });
    const paidAdapter = await mockAdapterFor(harness, recordOf(harness, "paid"));
    const failing = await mockAdapterFor(harness, recordOf(harness, "primary"));
    // Same failure, but after the prompt was sent, so the prompt is already upstream.
    failing.failWith = "provider_unavailable";
    failing.failAfterStart = true;

    const res = await harness.post(chatRequest("primary"));
    expect(res.statusCode).toBe(503);
    expect(paidAdapter.calls).toBe(0);
    await harness.app.close();
  });

  it("T18: a connection without permission cannot serve traffic", () => {
    for (const permission of ["pending", "denied"] as const) {
      const record = withOverrides(mockConnection("gated"), {
        kind: "consumer_web",
        permission,
      });
      const error = capture(() => assertTrafficAllowed(record));
      expect(error?.code).toBe("policy_disabled");
    }
  });

  it("T18b: the kill switch stops a connection regardless of its permission", () => {
    const record = withOverrides(mockConnection("live"), { enabled: false });
    expect(capture(() => assertTrafficAllowed(record))?.code).toBe("policy_disabled");
    expect(() => assertTrafficAllowed(mockConnection("live"))).not.toThrow();
  });

  it("T18c: provider permission is still refused for a personal-use web connection used by others", () => {
    const shared = claudeConnection({ personalUse: true });
    expect(() => assertTrafficAllowed(shared)).not.toThrow();

    // The same connection, without the owner-only acknowledgement, is not permitted.
    const forOthers = withOverrides(shared, { options: { ...shared.options, personal_use: false } });
    expect(capture(() => assertTrafficAllowed(forOthers))?.code).toBe("policy_disabled");
  });

  it("T18d: claudeConnection refuses to be built without the owner acknowledgement", () => {
    expect(() => claudeConnection({ personalUse: false })).toThrow(/personalUse/);
  });

  it("personal-use pacing: a daily local limit is enforced and labelled as local", () => {
    const record = claudeConnection({ personalUse: true, maxTurnsPerDay: 3, minIntervalMs: 0 });
    let clock = 1_000_000;
    const budget = new TurnBudget(() => 3, () => clock);
    expect(capture(() => budget.check(record))?.code).toBe("rate_limited");
    const quieter = new TurnBudget(() => 2, () => clock);
    expect(() => quieter.check(record)).not.toThrow();
    clock += 1;
    expect(() => quieter.check(record)).not.toThrow();
  });

  it("personal-use pacing: turns closer than the minimum interval are refused", () => {
    const record = claudeConnection({ personalUse: true, maxTurnsPerDay: 500, minIntervalMs: 15_000 });
    let clock = 1_000_000;
    const budget = new TurnBudget(() => 0, () => clock);
    budget.mark(record);
    expect(capture(() => budget.check(record))?.details.retry_after_s).toBe(15);
    clock += 16_000;
    expect(() => budget.check(record)).not.toThrow();
  });

  it("non-personal routes are not throttled by the web guardrail", () => {
    const record = withOverrides(mockConnection("api"), { kind: "free_api", consumption: "free_quota" });
    let clock = 0;
    const budget = new TurnBudget(() => 99_999, () => clock);
    budget.mark(record);
    expect(() => budget.check(record)).not.toThrow();
  });
});

function capture(fn: () => void): BridgeError | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof BridgeError ? err : undefined;
  }
}
