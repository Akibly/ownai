import { describe, expect, it } from "vitest";
import type { ConnectionRecord } from "@ownai/contracts";
import { accountWebConnection, claudeConnection, mockConnection } from "../src/connections.ts";
import { CONSOLE_JS, maskKey, renderConsole } from "../src/console.ts";
import { BridgeStore } from "../src/stores/store.ts";
import { chatRequest, makeHarness } from "./helpers.ts";

/** The loopback console (FR-20's first slice): status only, and provably inert. */

export const TEST_KEY = "sk-ownai-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

function pageFor(connections: ConnectionRecord[], events: Parameters<BridgeStore["recordEvent"]>[0] = {
  request_id: "r1",
  connection_id: "claude-web",
  route: "A",
  consumption: "free_quota",
  model_confidence: "provider_declared",
  outcome: "ok",
  duration_ms: 1234,
}): string {
  const store = BridgeStore.inMemory();
  for (const record of connections) store.upsertConnection(record);
  store.recordEvent(events);
  const html = renderConsole({
    store,
    host: "127.0.0.1:8791",
    version: "0.1.0",
    keyPreview: maskKey(TEST_KEY),
    keyRevealable: true,
    now: () => Date.parse("2026-10-27T12:00:00Z"),
  });
  store.close();
  return html;
}

describe("console rendering", () => {
  it("does not offer disabled or refused connections as client models", () => {
    const html = pageFor([mockConnection(), { ...mockConnection("disabled-model"), enabled: false }]);
    expect(html).toContain('value="mock"');
    expect(html).not.toContain('value="disabled-model"');
    expect(html).toContain("disabled-model");
  });

  it("gives an empty installation a setup path and disables unavailable credentials", () => {
    const store = BridgeStore.inMemory();
    try {
      const html = renderConsole({ store, host: "127.0.0.1:8791", version: "test", keyPreview: null, keyRevealable: false });
      expect(html).toContain("No model connected yet");
      expect(html).toContain("Add a connection");
      expect(html).toContain("No enabled connections");
      expect(html).toContain('aria-label="Copy API key" disabled');
      expect(html).not.toContain("data-reveal");
    } finally { store.close(); }
  });

  it("states the budget and the honest serving verdict for a personal-use connection", () => {
    const html = pageFor([claudeConnection({ personalUse: true, maxTurnsPerDay: 5, minIntervalMs: 15_000 })]);
    expect(html).toContain("1 of 5 turns used today");
    expect(html).toContain("serves owner-only use");
    expect(html).not.toContain(">serves traffic<");
    expect(html).toContain("Provider prohibits this use");
    expect(html).toContain("serves your own turns only");
    expect(html).not.toContain("cannot serve traffic");
    expect(html).toContain("15 s apart");
    expect(html).toContain("http://127.0.0.1:8791/v1");
    expect(html).toContain("1234 ms");
  });

  it("escapes a value it did not choose, so an alias cannot inject markup", () => {
    const hostile = { ...mockConnection("x"), alias: "<script>alert(1)</script>" };
    const html = pageFor([hostile], {
      request_id: "r1",
      connection_id: "x",
      route: "test",
      consumption: "none",
      model_confidence: "verified",
      outcome: "ok",
      duration_ms: 3,
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders selector editors only for known consumer sites, with defaults outside editable fields", () => {
    const records = [
      claudeConnection({ personalUse: true }),
      ...(["chatgpt", "grok", "qwen", "deepseek"] as const).map(provider => accountWebConnection({ provider, personalUse: true })),
      mockConnection(),
    ];
    const html = pageFor(records);
    expect(html.match(/class="selector-form"/g)).toHaveLength(5);
    expect(html.match(/data-group="composer"/g)).toHaveLength(5);
    expect(html).toContain("Using defaults");
    expect(html).toContain("Defaults:");
    expect(html).toContain("Undo edits");
    expect(html).toContain('aria-label="Selectors for claude"');
    expect(html).toContain('aria-describedby="sel-claude-web-help sel-claude-web-composer-hint"');
    expect(html.match(/<textarea[^>]+data-group="[^"]+"[^>]*>[\s\S]*?<\/textarea>/g)).toHaveLength(25);
    for (const textarea of html.match(/<textarea[^>]+data-group="[^"]+"[^>]*>[\s\S]*?<\/textarea>/g) ?? []) {
      expect(textarea).toMatch(/><\/textarea>$/);
    }
    expect(pageFor([mockConnection()])).not.toContain("selector-form");
  });

  it("escapes saved selectors rather than allowing them to close their textarea", () => {
    const record = claudeConnection({ personalUse: true });
    record.options.selectors = { composer: ['</textarea><script>alert("x")</script>', '#second'] };
    const html = pageFor([record]);
    expect(html).not.toContain('</textarea><script>');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n#second</textarea>');
    expect(html).toContain("Custom override");
    expect(html).not.toContain('onerror=');
  });

  it("serves syntactically valid editor JavaScript", () => {
    expect(() => new Function(CONSOLE_JS)).not.toThrow();
  });

  it("loads one same-origin script and nothing inline", () => {
    const html = pageFor([claudeConnection({ personalUse: true })]);
    expect(html).toContain('<script src="/console.js" defer></script>');
    expect(html).not.toMatch(/<script(?!\s+src=)/);
    expect(html).not.toContain("onclick=");
  });

  it("styles nothing inline, because style-src 'self' blocks it without an error on screen", () => {
    const html = pageFor([mockConnection(), claudeConnection({ personalUse: true })]);
    expect(html).not.toMatch(/<[^>]+\bstyle="/);
    // The script positions its copy fallback through a class for the same reason.
    expect(CONSOLE_JS).not.toMatch(/\.style\.|setAttribute\("style"/);
  });

  it("still copies when the async clipboard refuses the write", () => {
    expect(CONSOLE_JS).toContain("legacyCopy");
    expect(CONSOLE_JS).toContain('document.execCommand("copy")');
    // Every report has to land somewhere, or a failure looks like a dead button.
    expect(CONSOLE_JS).toContain('closest(".row")');
  });

  it("gives every button a status element to report into", () => {
    const html = pageFor([mockConnection(), claudeConnection({ personalUse: true })]);
    const rows = html.split('<div class="row">').slice(1);
    const withButtons = rows.filter((row) => row.includes("<button"));
    expect(withButtons.length).toBeGreaterThanOrEqual(5);
    for (const row of withButtons) expect(row).toContain('class="state"');
  });

  it("masks the key in the markup and keeps the plaintext out of it", () => {
    const html = pageFor([claudeConnection({ personalUse: true })]);
    expect(html).toContain(maskKey(TEST_KEY)!);
    expect(html).not.toContain(TEST_KEY);
    expect(html).toContain("data-reveal");
    expect(html).toContain('id="snippet-curl"');
  });

  it("shows each key under the label it was minted with", () => {
    expect(maskKey(TEST_KEY)).toBe("sk-ownai-abc••••••••••••••••••");
    // The owner's key predates the rename. It is still their key, so the preview
    // says what they would have pasted into a client rather than what this build mints.
    expect(maskKey("sk-local-abcdefghijklmnopqrstuvwxyz0123456789ABCD")).toBe(
      "sk-local-abc••••••••••••••••••",
    );
    expect(maskKey(null)).toBeNull();
  });

  it("keeps a snippet copyable: single quotes survive and the real model is named", () => {
    const text = pageFor([claudeConnection({ personalUse: true })])
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(text).toContain(`-d '{"model":"claude"`);
  });
});

describe("console route", () => {
  it("serves status without a key, with no CORS headers, and only over a loopback Host", async () => {
    const harness = await makeHarness();
    const page = await harness.get("/console");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    // Reading status is not the same privilege as spending a turn or revealing a secret.
    expect(page.payload).not.toContain(harness.key);
    const foreign = await harness.get("/console", { host: "evil.example:8791" });
    expect(foreign.statusCode).toBe(403);
    await harness.app.close();
  });

  it("redirects the bare origin to the console and serves the stylesheet as CSS", async () => {
    const harness = await makeHarness();
    const root = await harness.get("/");
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/console");
    const css = await harness.get("/console.css");
    expect(css.statusCode).toBe(200);
    expect(String(css.headers["content-type"])).toContain("text/css");
    expect(String(css.headers["x-content-type-options"])).toBe("nosniff");
    await harness.app.close();
  });

  it("lists a served request by metadata and never by its text", async () => {
    const harness = await makeHarness();
    await harness.post(chatRequest("mock", "words that must never be stored or shown"));
    const page = await harness.get("/console");
    expect(page.payload).toContain("Mock provider");
    expect(page.payload).not.toContain("words that must never be stored or shown");
    await harness.app.close();
  });

  it("still gates generation routes by key while the console stays open", async () => {
    const harness = await makeHarness();
    expect((await harness.get("/console")).statusCode).toBe(200);
    const noKey = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { host: "127.0.0.1:8791" },
      payload: chatRequest("mock"),
    });
    expect(noKey.statusCode).toBe(401);
    await harness.app.close();
  });

  it("refuses to reveal a key when no credential store is wired", async () => {
    const harness = await makeHarness();
    const res = await harness.get("/console/key");
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("no_credential_store");
    await harness.app.close();
  });

  it("reveals the full key only on its own route, never in the page", async () => {
    const revealed = "sk-local-revealed-value-abcdefghijklmnopqrstuvwx";
    const harness = await makeHarness({ revealGatewayKey: async () => revealed });
    const page = await harness.get("/console");
    expect(page.payload).toContain(maskKey(revealed)!);
    expect(page.payload).not.toContain(revealed);

    const res = await harness.get("/console/key");
    expect(res.statusCode).toBe(200);
    expect(res.body.key).toBe(revealed);
    expect(res.headers["cache-control"]).toBe("no-store");

    const empty = await makeHarness({ revealGatewayKey: async () => null });
    expect((await empty.get("/console/key")).statusCode).toBe(404);
    await harness.app.close();
    await empty.app.close();
  });

  it("serves its script as JavaScript, so the CSP can stay script-src 'self'", async () => {
    const harness = await makeHarness();
    const js = await harness.get("/console.js");
    expect(js.statusCode).toBe(200);
    expect(String(js.headers["content-type"])).toContain("text/javascript");
    expect(String(js.headers["x-content-type-options"])).toBe("nosniff");
    expect(js.payload).toContain("/console/key");
    await harness.app.close();
  });
});
