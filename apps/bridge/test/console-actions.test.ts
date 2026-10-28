import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SiteConnector } from "@ownai/adapters";
import type { ConnectionRecord, FinishReason } from "@ownai/contracts";
import { apiConnection, claudeConnection, mockChatConnection, mockConnection } from "../src/connections.ts";
import { maskKey, renderConsole } from "../src/console.ts";
import { servesTraffic } from "../src/policy.ts";
import { BridgeStore } from "../src/stores/store.ts";
import { makeHarness, type Harness } from "./helpers.ts";

/**
 * The one state change the console makes: enable or disable a connection. Two things
 * are proven here — the CSRF boundary (a web page cannot drive it; the owner's own
 * same-origin console can) and that the action stays local (it flips a flag and nothing
 * else, and it cannot override what the router will actually serve).
 */

const SELF = "http://127.0.0.1:8791";
const PATCH_URL = "/console/connections/mock";

describe("console connection actions", () => {
  it("disables then re-enables a connection over a same-origin request", async () => {
    const harness = await makeHarness();
    const off = await harness.patch(PATCH_URL, { enabled: false }, { Origin: SELF });
    expect(off.statusCode).toBe(200);
    expect(off.body.connection.enabled).toBe(false);
    expect(harness.store.getConnection("mock")!.enabled).toBe(false);

    const on = await harness.patch(PATCH_URL, { enabled: true }, { Origin: SELF });
    expect(on.statusCode).toBe(200);
    expect(on.body.connection.enabled).toBe(true);
    expect(harness.store.getConnection("mock")!.enabled).toBe(true);
    await harness.app.close();
  });

  it("refuses a cross-origin mutation before it changes anything", async () => {
    const harness = await makeHarness();
    const res = await harness.patch(PATCH_URL, { enabled: false }, { Origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("forbidden_origin");
    expect(harness.store.getConnection("mock")!.enabled).toBe(true);
    await harness.app.close();
  });

  it("refuses a mutation without the gateway key, even with no Origin (a plain local call)", async () => {
    const harness = await makeHarness();
    const res = await harness.patch(PATCH_URL, { enabled: false }, { authorization: "Bearer sk-ownai-wrong" });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
    expect(harness.store.getConnection("mock")!.enabled).toBe(true);
    await harness.app.close();
  });

  it("rejects a body that is not a boolean enabled flag", async () => {
    const harness = await makeHarness();
    const res = await harness.patch(PATCH_URL, { enabled: "yes" }, { Origin: SELF });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    await harness.app.close();
  });

  it("rejects an unknown connection id", async () => {
    const harness = await makeHarness();
    const res = await harness.patch("/console/connections/no-such", { enabled: true }, { Origin: SELF });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    await harness.app.close();
  });

  it("enabling a policy-refused connection still does not make it serve traffic", async () => {
    const refused = { ...mockConnection("refused"), permission: "denied" as const };
    const harness = await makeHarness({ connections: [refused] });
    expect(servesTraffic(refused)).toBe(false);
    const res = await harness.patch("/console/connections/refused", { enabled: true }, { Origin: SELF });
    expect(res.statusCode).toBe(200);
    const after = harness.store.getConnection("refused")!;
    expect(after.enabled).toBe(true);
    // The flag is on, but the permission gate is untouched by the console.
    expect(servesTraffic(after)).toBe(false);
    await harness.app.close();
  });

  it("renders a toggle for every connection, labelled against its current state", () => {
    const store = BridgeStore.inMemory();
    try {
      store.upsertConnection(mockConnection()); // enabled -> offers Disable
      store.upsertConnection({ ...mockConnection("off"), enabled: false }); // disabled -> offers Enable
      const html = renderConsole({
        store,
        host: "127.0.0.1:8791",
        version: "test",
        keyPreview: maskKey("sk-ownai-abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
        keyRevealable: true,
      });
      expect(html).toContain('data-action="disable" data-connection="mock"');
      expect(html).toContain('data-action="enable" data-connection="off"');
    } finally {
      store.close();
    }
  });
});

describe("console connection tester", () => {
  const TEST_URL = "/console/connections/mock/test";

  it("checks a mock connection with a single, turn-free call", async () => {
    const harness = await makeHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: TEST_URL,
      headers: { host: "127.0.0.1:8791", authorization: `Bearer ${harness.key}`, Origin: SELF },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({ ok: true, state: "ready" });
    await harness.app.close();
  });

  it("asks for confirmation before touching a live browser site, and reaches no adapter", async () => {
    const site = stubSite();
    const harness = await makeHarness({
      connections: [claudeConnection({ personalUse: true })],
      connectors: { "browser:claude": () => site },
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/console/connections/claude-web/test",
      headers: { host: "127.0.0.1:8791", authorization: `Bearer ${harness.key}`, Origin: SELF },
      payload: {},
    });
    const body = JSON.parse(response.payload);
    expect(response.statusCode).toBe(200);
    expect(body.requires_confirmation).toBe(true);
    expect(body.warning).toContain("opens a window on the provider's own site");
    // The connector was never consulted: agreeing is what launches the browser.
    expect(site.calls).toEqual([]);
    await harness.app.close();
  });

  it("consults the site read-only once the owner agrees, and submits nothing", async () => {
    const site = stubSite({ signedIn: false });
    const harness = await makeHarness({
      connections: [claudeConnection({ personalUse: true })],
      connectors: { "browser:claude": () => site },
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/console/connections/claude-web/test",
      headers: { host: "127.0.0.1:8791", authorization: `Bearer ${harness.key}`, Origin: SELF },
      payload: { confirm: true },
    });
    const body = JSON.parse(response.payload);
    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.state).toBe("needs_login");
    expect(body.detail).toContain("sign in");
    // A check reads the page. It never starts a conversation, so it spends no turn.
    expect(site.calls).toEqual(["detectChallenge", "isSignedIn"]);
    await harness.app.close();
  }, 120_000);

  it("reports a signed-in site as ready from the same read-only check", async () => {
    const site = stubSite({ signedIn: true });
    const harness = await makeHarness({
      connections: [claudeConnection({ personalUse: true })],
      connectors: { "browser:claude": () => site },
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/console/connections/claude-web/test",
      headers: { host: "127.0.0.1:8791", authorization: `Bearer ${harness.key}`, Origin: SELF },
      payload: { confirm: true },
    });
    expect(JSON.parse(response.payload)).toMatchObject({ ok: true, state: "ready" });
    expect(site.calls).toEqual(["detectChallenge", "isSignedIn"]);
    await harness.app.close();
  }, 120_000);

  it("refuses a cross-origin check", async () => {
    const harness = await makeHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: TEST_URL,
      headers: { host: "127.0.0.1:8791", authorization: `Bearer ${harness.key}`, Origin: "https://evil.example" },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.payload).error.code).toBe("forbidden_origin");
    await harness.app.close();
  });

  it("refuses a check without the gateway key", async () => {
    const harness = await makeHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: TEST_URL,
      headers: { host: "127.0.0.1:8791", Origin: SELF, "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_api_key");
    await harness.app.close();
  });

  it("cannot test a disabled connection", async () => {
    const harness = await makeHarness();
    harness.store.setConnectionEnabled("mock", false);
    const response = await harness.app.inject({
      method: "POST",
      url: TEST_URL,
      headers: { host: "127.0.0.1:8791", authorization: `Bearer ${harness.key}`, Origin: SELF },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.payload).error.code).toBe("policy_disabled");
    await harness.app.close();
  });
});

describe("console selector editor", () => {
  let harness: Harness;
  let record: ConnectionRecord;
  let registryGet: MockInstance<Harness["registry"]["get"]>;
  let events: ReturnType<BridgeStore["recentEvents"]>;
  const turnsToday = vi.fn(() => 100);
  const initialSelectors = {
    composer: ["#old-composer"],
    assistant_message: [".old-assistant"],
    challenge: [".old-challenge"],
  };

  beforeEach(async () => {
    const base = claudeConnection({
      personalUse: true,
      id: "selector-editor",
      alias: "custom-alias",
      mode: "background",
      channel: "msedge",
      maxTurnsPerDay: 12,
      minIntervalMs: 4500,
    });
    record = {
      ...base,
      model: "owner-selected-model",
      secret_ref: "test-secret-reference",
      fallback_ids: ["fallback"],
      options: {
        ...base.options,
        custom_config: { keep: true },
        selectors: initialSelectors,
      },
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    };
    turnsToday.mockClear();
    harness = await makeHarness({ connections: [record], turnsToday });
    registryGet = vi.spyOn(harness.registry, "get").mockImplementation(async () => {
      throw new Error("Selector configuration must never reach an adapter");
    });
    harness.store.recordEvent({
      request_id: "previous-turn",
      connection_id: record.id,
      route: "consumer_web",
      consumption: record.consumption,
      model_confidence: "unknown",
      outcome: "success",
      duration_ms: 1,
    });
    events = harness.store.recentEvents();
  });

  afterEach(async () => {
    try {
      expect(registryGet).not.toHaveBeenCalled();
      expect(turnsToday).not.toHaveBeenCalled();
      expect(harness.store.recentEvents()).toEqual(events);
    } finally {
      await harness.app.close();
      harness.store.close();
      registryGet.mockRestore();
    }
  });

  function postSelectors(payload: unknown, id = record.id, headers: Record<string, string | undefined> = {}) {
    const requestHeaders: Record<string, string> = {
      host: "127.0.0.1:8791",
      authorization: `Bearer ${harness.key}`,
      origin: SELF,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    };
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) delete requestHeaders[name];
      else requestHeaders[name] = value;
    }
    return harness.app.inject({
      method: "POST",
      url: `/console/connections/${id}/selectors`,
      headers: requestHeaders,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  function expectSelectors(selectors: Record<string, string[]>, before = record) {
    expect(harness.store.getConnection(before.id)).toEqual({
      ...before,
      options: { ...before.options, selectors },
      updated_at: expect.any(String),
    });
  }

  it.each([
    "browser:claude",
    "browser:chatgpt",
    "browser:grok",
    "browser:qwen",
    "browser:deepseek",
  ] as const)("saves all supported groups for %s without contacting a provider", async (type) => {
    const { selectors: _selectors, ...options } = record.options;
    const before = { ...record, type, options };
    harness.store.upsertConnection(before);
    const groups = {
      composer: ["  textarea  ", "\n[contenteditable=\"true\"]\t"],
      assistant_message: [" .assistant "],
      stop_button: [" button.stop "],
      model_picker: [" #model-picker "],
      challenge: [" .challenge "],
    };
    const expected = {
      composer: ["textarea", "[contenteditable=\"true\"]"],
      assistant_message: [".assistant"],
      stop_button: ["button.stop"],
      model_picker: ["#model-picker"],
      challenge: [".challenge"],
    };
    const response = await postSelectors({ groups });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.payload)).toEqual({
      ok: true,
      connection: { id: before.id, alias: before.alias },
      selectors: expected,
    });
    expectSelectors(expected, before);
  });

  it("merges successive partial edits while preserving unrelated options and connection fields", async () => {
    const first = await postSelectors({ groups: { composer: [" #new-composer "] } });
    expect(first.statusCode).toBe(200);
    const second = await postSelectors({ groups: { stop_button: [" .stop "] } });
    expect(second.statusCode).toBe(200);
    const expected = { ...initialSelectors, composer: ["#new-composer"], stop_button: [".stop"] };
    expect(JSON.parse(second.payload).selectors).toEqual(expected);
    expectSelectors(expected);
  });

  it("resets only the specified override to defaults and can edit another group in the same request", async () => {
    const response = await postSelectors({ groups: { composer: [], stop_button: [" .stop "] } });
    expect(response.statusCode).toBe(200);
    const expected = {
      assistant_message: initialSelectors.assistant_message,
      challenge: initialSelectors.challenge,
      stop_button: [".stop"],
    };
    expect(JSON.parse(response.payload).selectors).toEqual(expected);
    expectSelectors(expected);
    expect(harness.store.getConnection(record.id)!.options.selectors).not.toHaveProperty("composer");
  });

  it("resets the last overrides without retaining empty lists", async () => {
    const response = await postSelectors({ groups: { composer: [], assistant_message: [], challenge: [] } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).selectors).toEqual({});
    expectSelectors({});
  });

  it("accepts resetting an absent override without changing existing overrides", async () => {
    const response = await postSelectors({ groups: { model_picker: [] } });
    expect(response.statusCode).toBe(200);
    expectSelectors(initialSelectors);
  });

  it("accepts eight selectors of exactly 300 characters", async () => {
    const composer = Array.from({ length: 8 }, (_, index) => `#${index}${"a".repeat(298)}`);
    const response = await postSelectors({ groups: { composer } });
    expect(response.statusCode).toBe(200);
    expectSelectors({ ...initialSelectors, composer });
  });

  it.each([
    { state: "disabled", enabled: false, permission: "denied", personalUse: true },
    { state: "policy-refused", enabled: true, permission: "denied", personalUse: false },
    { state: "pending permission", enabled: true, permission: "pending", personalUse: false },
  ] as const)("configures a $state connection without enabling traffic", async ({ enabled, permission, personalUse }) => {
    const before = { ...record, enabled, permission, options: { ...record.options, personal_use: personalUse } };
    harness.store.upsertConnection(before);
    expect(servesTraffic(before)).toBe(false);
    const response = await postSelectors({ groups: { composer: ["#new-composer"] } });
    expect(response.statusCode).toBe(200);
    expectSelectors({ ...initialSelectors, composer: ["#new-composer"] }, before);
    expect(servesTraffic(harness.store.getConnection(record.id)!)).toBe(false);
  });

  it.each([
    apiConnection({ id: "api", type: "free_api:openai", provider: "OpenAI", kind: "free_api", consumption: "free_quota", model: "test-model" }),
    mockConnection(),
    mockChatConnection("http://127.0.0.1:8792"),
  ])("rejects selectors for $type", async (unsupported) => {
    harness.store.upsertConnection(unsupported);
    const before = harness.store.listConnections();
    const response = await postSelectors({ groups: { composer: ["textarea"] } }, unsupported.id);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.listConnections()).toEqual(before);
  });

  it("rejects an unknown connection without creating it", async () => {
    const before = harness.store.listConnections();
    const response = await postSelectors({ groups: { composer: ["textarea"] } }, "no-such");
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.getConnection("no-such")).toBeUndefined();
    expect(harness.store.listConnections()).toEqual(before);
  });

  it.each([
    { name: "missing key", headers: { authorization: undefined }, status: 401, code: "invalid_api_key" },
    { name: "wrong key", headers: { authorization: "Bearer sk-ownai-wrong" }, status: 401, code: "invalid_api_key" },
    { name: "foreign Origin", headers: { origin: "https://evil.example" }, status: 403, code: "forbidden_origin" },
    { name: "null Origin", headers: { origin: "null" }, status: 403, code: "forbidden_origin" },
    { name: "foreign Host", headers: { host: "evil.example:8791", origin: "http://evil.example:8791" }, status: 403, code: "forbidden_origin" },
  ])("rejects a $name before changing configuration", async ({ headers, status, code }) => {
    const response = await postSelectors({ groups: { composer: ["#new-composer"] } }, record.id, headers);
    expect(response.statusCode).toBe(status);
    expect(JSON.parse(response.payload).error.code).toBe(code);
    expect(harness.store.getConnection(record.id)).toEqual(record);
  });

  it("accepts an authenticated local call without an Origin", async () => {
    const response = await postSelectors({ groups: { composer: ["textarea"] } }, record.id, { origin: undefined });
    expect(response.statusCode).toBe(200);
    expectSelectors({ ...initialSelectors, composer: ["textarea"] });
  });

  it.each(["unknown", "Composer", "constructor", "toString", "__proto__"])("rejects the unknown group %s", async (group) => {
    const response = await postSelectors({ groups: { [group]: ["textarea"] } });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.getConnection(record.id)).toEqual(record);
  });

  it.each([
    { name: "missing body", payload: undefined },
    { name: "null body", payload: null },
    { name: "array body", payload: [] },
    { name: "string body", payload: "groups" },
    { name: "missing groups", payload: {} },
    { name: "empty groups", payload: { groups: {} } },
    { name: "null groups", payload: { groups: null } },
    { name: "array groups", payload: { groups: [] } },
    { name: "string groups", payload: { groups: "composer" } },
    { name: "number groups", payload: { groups: 1 } },
    { name: "boolean groups", payload: { groups: true } },
    { name: "null value", payload: { groups: { composer: null } } },
    { name: "string value", payload: { groups: { composer: "textarea" } } },
    { name: "object value", payload: { groups: { composer: { selector: "textarea" } } } },
    { name: "number value", payload: { groups: { composer: 1 } } },
    { name: "boolean value", payload: { groups: { composer: false } } },
    { name: "empty selector", payload: { groups: { composer: [""] } } },
    { name: "blank selector", payload: { groups: { composer: [" \t\r\n "] } } },
    { name: "null selector", payload: { groups: { composer: [null] } } },
    { name: "number selector", payload: { groups: { composer: [1] } } },
    { name: "boolean selector", payload: { groups: { composer: [true] } } },
    { name: "object selector", payload: { groups: { composer: [{}] } } },
    { name: "nested array selector", payload: { groups: { composer: [["textarea"]] } } },
    { name: "mixed selector types", payload: { groups: { composer: ["textarea", 1] } } },
    { name: "nine selectors", payload: { groups: { composer: Array.from({ length: 9 }, (_, index) => `#composer-${index}`) } } },
    { name: "301-character selector", payload: { groups: { composer: ["a".repeat(301)] } } },
    { name: "overlong selector padded with whitespace", payload: { groups: { composer: [` ${"a".repeat(299)} `] } } },
  ])("rejects $name without changing stored configuration", async ({ payload }) => {
    const response = await postSelectors(payload);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.getConnection(record.id)).toEqual(record);
  });

  it.each([
    { assistant_message: ["valid", " "] },
    { unknown: [".unknown"] },
  ])("does not persist an earlier replacement or reset when a later group fails validation: %j", async (invalidGroup) => {
    const response = await postSelectors({ groups: { composer: ["#new-composer"], challenge: [], ...invalidGroup } });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.getConnection(record.id)).toEqual(record);
  });
});

/**
 * The opt-in that lets a tool-calling client use a browser route. Proven here to be
 * config only: it opens no window, spends no turn, and records no event.
 */
describe("prompt-mediated tool setting", () => {
  const SELF_ORIGIN = "http://127.0.0.1:8791";
  let harness: Harness;
  let record: ConnectionRecord;

  beforeEach(async () => {
    harness = await makeHarness({ connections: [claudeConnection({ personalUse: true })] });
    record = harness.store.getConnection("claude-web")!;
  });

  afterEach(async () => {
    await harness.app.close();
    harness.store.close();
  });

  function post(body: unknown, id = record.id, headers: Record<string, string | undefined> = {}) {
    const requestHeaders: Record<string, string> = {
      host: "127.0.0.1:8791",
      authorization: `Bearer ${harness.key}`,
      origin: SELF_ORIGIN,
      "content-type": "application/json",
      ...(headers as Record<string, string>),
    };
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) delete requestHeaders[name];
    }
    return harness.app.inject({
      method: "POST",
      url: `/console/connections/${id}/prompt-tools`,
      headers: requestHeaders,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  it("turns the protocol on then off, leaving the rest of the connection alone", async () => {
    const events = harness.store.recentEvents();
    const on = await post({ on: true });
    expect(on.statusCode).toBe(200);
    expect(on.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(on.payload)).toEqual({
      ok: true,
      connection: { id: record.id, alias: record.alias },
      prompt_tools: true,
    });
    expect(harness.store.getConnection(record.id)).toEqual({
      ...record,
      options: { ...record.options, prompt_tools: true },
      updated_at: expect.any(String),
    });

    const off = await post({ on: false });
    expect(off.statusCode).toBe(200);
    expect(harness.store.getConnection(record.id)!.options).not.toHaveProperty("prompt_tools");
    expect(harness.store.recentEvents()).toEqual(events);
  });

  it.each([
    { name: "a provider API route", record: apiConnection({ id: "api", type: "free_api:openai", provider: "OpenAI", kind: "free_api", consumption: "free_quota", model: "gpt-4o-mini" }) },
    { name: "the echo model", record: mockConnection() },
  ])("refuses $name, which has no page to describe functions to", async ({ record: unsupported }) => {
    harness.store.upsertConnection(unsupported);
    const before = harness.store.listConnections();
    const response = await post({ on: true }, unsupported.id);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.listConnections()).toEqual(before);
  });

  it("refuses an unknown connection without creating it", async () => {
    const before = harness.store.listConnections();
    const response = await post({ on: true }, "no-such");
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.getConnection("no-such")).toBeUndefined();
    expect(harness.store.listConnections()).toEqual(before);
  });

  it.each([
    { name: "missing body", body: undefined },
    { name: "null body", body: null },
    { name: "array body", body: [] },
    { name: "string body", body: "on" },
    { name: "empty object", body: {} },
    { name: "null on", body: { on: null } },
    { name: "string on", body: { on: "yes" } },
    { name: "number on", body: { on: 1 } },
    { name: "object on", body: { on: { value: true } } },
  ])("rejects a $name before writing it", async ({ body }) => {
    const response = await post(body);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe("invalid_request");
    expect(harness.store.getConnection(record.id)).toEqual(record);
  });

  it.each([
    { name: "missing key", headers: { authorization: undefined }, status: 401, code: "invalid_api_key" },
    { name: "foreign Origin", headers: { origin: "https://evil.example" }, status: 403, code: "forbidden_origin" },
    { name: "foreign Host", headers: { host: "evil.example:8791", origin: "http://evil.example:8791" }, status: 403, code: "forbidden_origin" },
  ])("refuses a $name call that would have changed the setting", async ({ headers, status, code }) => {
    const response = await post({ on: true }, record.id, headers);
    expect(response.statusCode).toBe(status);
    expect(JSON.parse(response.payload).error.code).toBe(code);
    expect(harness.store.getConnection(record.id)).toEqual(record);
  });

  it("accepts an authenticated local call with no Origin", async () => {
    const response = await post({ on: true }, record.id, { origin: undefined });
    expect(response.statusCode).toBe(200);
    expect(harness.store.getConnection(record.id)!.options.prompt_tools).toBe(true);
  });
});

/**
 * A site connector that records what the engine asked of it. Pointed at about:blank, so
 * the read-only check opens a local window and reaches no provider host.
 */
function stubSite(options: { signedIn?: boolean } = {}): SiteConnector & { calls: string[] } {
  const calls: string[] = [];
  const signedIn = options.signedIn ?? false;
  return {
    calls,
    id: "claude",
    displayName: "Stub site",
    startUrl: "about:blank",
    loginUrl: "about:blank",
    consumption: "free_quota",
    streaming: "buffered",
    async isSignedIn() {
      calls.push("isSignedIn");
      return signedIn;
    },
    async detectChallenge() {
      calls.push("detectChallenge");
      return false;
    },
    async newConversation() {
      calls.push("newConversation");
    },
    async submitPrompt() {
      calls.push("submitPrompt");
    },
    async readReply() {
      calls.push("readReply");
      const finish: FinishReason = "stop";
      return { text: "stub", finish_reason: finish };
    },
    async stopGeneration() {
      calls.push("stopGeneration");
    },
    async modelLabel() {
      calls.push("modelLabel");
      return null;
    },
  };
}
