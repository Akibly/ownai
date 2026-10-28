import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeStore } from "../apps/bridge/src/stores/store.ts";
import { MemorySecretStore } from "../apps/bridge/src/secrets.ts";
import { createRuntime } from "../apps/bridge/src/runtime.ts";
import { startBridge } from "../apps/bridge/src/server.ts";
import { accountWebConnection, claudeConnection, mockConnection } from "../apps/bridge/src/connections.ts";

// Real-browser regression checks use only in-memory fixtures and mock generation.
const requireAdapters = createRequire(new URL("../packages/adapters/package.json", import.meta.url));
const { chromium } = requireAdapters("playwright") as typeof import("playwright");
const store = BridgeStore.inMemory();
const runtime = createRuntime({ store, secrets: new MemorySecretStore() });
const key = await runtime.ensureGatewayKey();
const getAdapter = runtime.registry.get.bind(runtime.registry);
const providerCalls: string[] = [];
runtime.registry.get = async record => {
  if (record.kind !== "mock") {
    providerCalls.push(record.id);
    throw new Error("This UI fixture must not reach a provider adapter.");
  }
  return getAdapter(record);
};
store.upsertConnection(mockConnection());
store.upsertConnection({ ...mockConnection("second"), alias: "second-model" });
store.upsertConnection({ ...claudeConnection({ personalUse: true, maxTurnsPerDay: 5 }), alias: "Claude preview fixture" });
for (const provider of ["chatgpt", "grok", "qwen", "deepseek"] as const) {
  store.upsertConnection(accountWebConnection({ provider, personalUse: true }));
}
store.upsertConnection({ ...mockConnection("disabled"), enabled: false });
store.recordEvent({ request_id: "preview-error", connection_id: "claude-web", route: "A", consumption: "free_quota", model_confidence: "unknown", outcome: "login_required", duration_ms: 112 });
const running = await startBridge({ store, registry: runtime.registry, router: runtime.router, port: 0, revealGatewayKey: async () => key.plaintext });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage();
const errors: string[] = [];
let expectedHttpError = false;
page.on("pageerror", error => errors.push(error.message));
page.on("console", msg => {
  if (msg.type() === "error" && !(expectedHttpError && /status of (409|503)/.test(msg.text()))) errors.push(msg.text());
});
await context.route("**/*", async route => {
  if (new URL(route.request().url()).origin !== running.url) {
    errors.push("Unexpected non-fixture request");
    await route.abort();
  } else await route.continue();
});
const captures = resolve(".impeccable/review/selector-editor");
await mkdir(captures, { recursive: true });
try {
  const response = await fetch(`${running.url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "console smoke" }] }),
  });
  assert.equal(response.status, 200);
  await page.goto(`${running.url}/console`);
  assert.equal(await page.locator("body").textContent().then(text => text!.includes(key.plaintext)), false);
  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-reveal]")?.textContent === "Hide");
  assert.equal(await page.locator("#keyline").textContent(), key.plaintext);
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  assert.notEqual(await page.locator("#keyline").textContent(), key.plaintext);

  assert.equal(await page.locator(".selector-form").count(), 5);
  const editor = page.locator(".selector-editor").filter({ has: page.locator('[data-connection="claude-web"]') });
  const form = editor.locator("form");
  const composer = form.getByLabel("Prompt box", { exact: true });
  const assistant = form.getByLabel("Assistant reply", { exact: true });
  const save = form.getByRole("button", { name: "Save selectors" });
  const status = form.getByRole("status");
  const selectorWrites: unknown[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/selectors")) {
      selectorWrites.push(request.postDataJSON());
      assert.equal(request.headers()["authorization"], `Bearer ${key.plaintext}`);
      assert.equal(request.headers()["origin"], running.url);
    }
  });
  const originalClaude = store.getConnection("claude-web")!;
  await editor.locator("summary").focus();
  await editor.locator("summary").press("Enter");
  assert.equal(await composer.isVisible(), true);
  assert.equal(await composer.inputValue(), "");
  await save.click();
  await status.filter({ hasText: "No changes to save" }).waitFor();
  assert.equal(selectorWrites.length, 0);

  await composer.fill("  #message-box  \n\n textarea[name='message'] ");
  await assistant.fill('[data-role="assistant"] .reply');
  await save.click();
  await status.filter({ hasText: "Saved." }).waitFor();
  assert.deepEqual(selectorWrites, [{ groups: {
    composer: ["#message-box", "textarea[name='message']"], assistant_message: ['[data-role="assistant"] .reply'],
  } }]);
  assert.deepEqual(store.getConnection("claude-web")!.options.selectors, {
    composer: ["#message-box", "textarea[name='message']"], assistant_message: ['[data-role="assistant"] .reply'],
  });
  const updatedClaude = store.getConnection("claude-web")!;
  assert.deepEqual({ ...updatedClaude, options: originalClaude.options, updated_at: originalClaude.updated_at }, originalClaude);
  assert.equal(await composer.inputValue(), "#message-box\ntextarea[name='message']");
  await composer.fill("#unsaved");
  await form.getByRole("button", { name: "Undo edits" }).click();
  assert.equal(await composer.inputValue(), "#message-box\ntextarea[name='message']");
  assert.equal(selectorWrites.length, 1);

  await page.reload();
  await editor.locator("summary").click();
  assert.equal(await composer.inputValue(), "#message-box\ntextarea[name='message']");
  assert.equal(await form.locator('[data-selector-mode]').filter({ hasText: "Custom override" }).count(), 2);
  await composer.fill( Array.from({ length: 9 }, (_, i) => `.candidate-${i}`).join("\n"));
  await save.click();
  assert.equal(await composer.getAttribute("aria-invalid"), "true");
  assert.equal(selectorWrites.length, 1);
  await composer.fill("x".repeat(301));
  await save.click();
  assert.equal(await composer.getAttribute("aria-invalid"), "true");
  assert.equal(selectorWrites.length, 1);

  await composer.fill("#retry-me");
  const saveRoute = "**/console/connections/claude-web/selectors";
  expectedHttpError = true;
  await page.route(saveRoute, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Test save unavailable" } }) }));
  await save.click();
  await status.filter({ hasText: "Test save unavailable" }).waitFor();
  await page.unroute(saveRoute);
  expectedHttpError = false;
  assert.equal(await composer.inputValue(), "#retry-me");
  assert.equal(await save.isEnabled(), true);
  assert.equal(await composer.isEnabled(), true);
  assert.deepEqual(store.getConnection("claude-web")!.options.selectors, updatedClaude.options.selectors);
  await save.click();
  await status.filter({ hasText: "Saved." }).waitFor();
  assert.deepEqual(store.getConnection("claude-web")!.options.selectors, {
    composer: ["#retry-me"], assistant_message: ['[data-role="assistant"] .reply'],
  });
  await composer.fill("");
  await save.click();
  await status.filter({ hasText: "Saved." }).waitFor();
  assert.deepEqual(store.getConnection("claude-web")!.options.selectors, { assistant_message: ['[data-role="assistant"] .reply'] });
  assert.equal(await form.locator(".selector-row").first().locator("[data-selector-mode]").textContent(), "Using defaults");
  await composer.fill("draft on the first card");
  const qwenEditor = page.locator(".selector-editor").filter({ has: page.locator('[data-connection="qwen-web"]') });
  await qwenEditor.locator("summary").click();
  await qwenEditor.getByLabel("Prompt box", { exact: true }).fill("#qwen-composer");
  await qwenEditor.getByRole("button", { name: "Save selectors" }).click();
  await qwenEditor.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  assert.equal(await composer.inputValue(), "draft on the first card");
  assert.deepEqual(store.getConnection("qwen-web")!.options.selectors, { composer: ["#qwen-composer"] });
  await form.getByRole("button", { name: "Undo edits" }).click();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await editor.screenshot({ path: resolve(captures, `selectors-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `Selector overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.reload();
  await editor.locator("summary").click();
  assert.equal(await composer.inputValue(), "");
  assert.deepEqual(providerCalls, []);

  await page.getByRole("tab", { name: "Node.js" }).click();
  assert.equal(await page.locator("#panel-node").isVisible(), true);
  await page.getByRole("tab", { name: "Node.js" }).press("ArrowRight");
  assert.equal(await page.locator("#panel-python").isVisible(), true);
  await page.locator("#model-select").selectOption("second-model");
  assert.match((await page.locator("#snippet-python").textContent())!, /model="second-model"/);
  await page.getByRole("tab", { name: "curl", exact: true }).click();
  assert.match((await page.locator("#snippet-curl").textContent())!, /"model":"second-model"/);
  assert.equal(await page.locator('#model-select option[value="disabled"]').count(), 0);

  // Exercise copying without putting a development credential on the OS clipboard.
  await page.evaluate(`(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { document.documentElement.dataset.copied = text; },
    } });
  })()`);
  await page.locator("#panel-curl").getByRole("button", { name: "Copy code" }).click();
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.copied));
  const copied = await page.evaluate(() => document.documentElement.dataset.copied!);
  assert.equal(copied.includes(key.plaintext), true);
  assert.equal(copied.includes("second-model"), true);
  await page.evaluate(() => { delete document.documentElement.dataset.copied; });
  await page.locator("#activity-search").fill("no-such-connection");
  assert.equal(await page.locator("#activity-empty").isVisible(), true);
  await page.locator("#activity-search").fill("");
  await page.locator("#activity-filter").selectOption("error");
  assert.equal(await page.locator("tr[data-outcome]:visible").count(), 1);
  await page.locator("#activity-filter").selectOption("all");
  await page.locator("#model-select").selectOption("mock");

  // The request tester sends only on submission and treats model output as text.
  await page.locator("#test-model").selectOption("mock");
  assert.equal(await page.locator("#test-model").inputValue(), "mock");
  assert.equal(await page.locator("#test-send").isDisabled(), true);
  const prompt = '<img src=x onerror="alert(1)"> console request';
  const before = store.countEventsFor("mock", "1970-01-01T00:00:00.000Z");
  await page.locator("#test-prompt").fill(prompt);
  assert.equal(store.countEventsFor("mock", "1970-01-01T00:00:00.000Z"), before);
  await page.locator("#test-send").click();
  await page.waitForFunction(() => document.getElementById("test-status")?.textContent?.startsWith("Response received."));
  assert.equal(await page.locator("#test-response").textContent(), `Mock reply: ${prompt}`);
  assert.equal(await page.locator("#test-response img").count(), 0);
  assert.equal(store.countEventsFor("mock", "1970-01-01T00:00:00.000Z"), before + 1);
  assert.equal(JSON.stringify(store.recentEvents()).includes(prompt), false);
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.copied));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.copied), `Mock reply: ${prompt}`);
  await page.evaluate(() => { delete document.documentElement.dataset.copied; });

  // A real mock-adapter refusal exercises the authenticated API and recovery copy.
  const adapter = await runtime.registry.get(store.getConnection("mock")!);
  assert.ok("failWith" in adapter);
  adapter.failWith = "login_required";
  expectedHttpError = true;
  await page.locator("#test-send").click();
  await page.waitForFunction(() => document.getElementById("test-status")?.textContent?.includes("pnpm bridge login"));
  expectedHttpError = false;
  assert.equal(await page.locator("#test-result").isVisible(), false);
  adapter.failWith = undefined;

  // Cancel while credentials are loading: the generation endpoint must not run.
  let keyStarted!: () => void;
  let releaseKey!: () => void;
  const keyStart = new Promise<void>(resolve => { keyStarted = resolve; });
  const keyHold = new Promise<void>(resolve => { releaseKey = resolve; });
  await page.route("**/console/key", async route => {
    keyStarted();
    await keyHold;
    await route.abort().catch(() => {});
  });
  const beforeCancel = store.countEventsFor("mock", "1970-01-01T00:00:00.000Z");
  await page.locator("#test-send").click();
  await keyStart;
  await page.locator("#test-stop").click();
  await page.waitForFunction(() => document.getElementById("test-status")?.textContent === "Request stopped before sending.");
  releaseKey();
  await page.unrouteAll({ behavior: "wait" });
  assert.equal(store.countEventsFor("mock", "1970-01-01T00:00:00.000Z"), beforeCancel);

  await page.locator("#test-clear").click();
  assert.equal(await page.locator("#test-prompt").inputValue(), "");
  assert.equal(await page.locator("#test-send").isDisabled(), true);
  await page.locator("#test-prompt").fill("Hello from OwnAI");
  await page.locator("#test-prompt").press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("test-status")?.textContent?.startsWith("Response received."));

  // No live provider interaction: the browser fixture's request count stays one.
  assert.equal(store.countEventsFor("claude-web", "1970-01-01T00:00:00.000Z"), 1);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(captures, width === 1440 ? "desktop.png" : width === 390 ? "mobile.png" : "tablet.png"), fullPage: true });
    await page.locator("#test").screenshot({ path: resolve(captures, `request-tester-${width}.png`) });
    const overflow = await page.evaluate(`Array.from(document.querySelectorAll('body *')).filter(e => e.getBoundingClientRect().right > innerWidth && getComputedStyle(e).position !== 'fixed').map(e => e.tagName + '.' + e.className)`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `Page overflow at ${width}px: ${overflow.join(", ")}`);
  }
  // Empty installation has an actionable setup path and no invalid request control.
  for (const connection of store.listConnections()) store.deleteConnection(connection.id);
  store.db.exec("DELETE FROM events");
  await page.reload();
  assert.equal(await page.getByText("No model connected yet", { exact: true }).isVisible(), true);
  assert.equal(await page.locator("#model-select").isDisabled(), true);
  assert.equal(await page.locator("#panel-curl button").isDisabled(), true);
  assert.equal(await page.locator("#test-send").isDisabled(), true);
  assert.equal(await page.locator("#test-prompt").isDisabled(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(providerCalls, []);
  console.log("PASS console: selector save/reload/reset/undo, validation, failed-save recovery, independent card drafts, reveal/hide, keyboard navigation, model selection, copying, filters, mock requests, cancellation, responsive layouts, empty state; no provider calls or unexpected browser errors");
  console.log(`Screenshots: ${captures}`);
} finally {
  await browser.close();
  await running.close();
  await runtime.close();
}
