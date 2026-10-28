import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BridgeError } from "@ownai/contracts";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNT_SITE_DEFINITIONS,
  accountSelectorGroups,
  AccountSiteConnector,
  BrowserChatAdapter,
  type AccountSiteDefinition,
} from "../src/index.ts";

/**
 * The four consumer chat sites share one connector, and its rules are the ones that
 * keep this route honest: never submit a prompt the composer did not actually take,
 * hand a human check back to the owner instead of touching it, and report a site-side
 * limit as a limit.
 *
 * The fixture below imitates only the page shape those rules read — a composer, an
 * assistant message that grows, a stop control, a model label. No provider site is
 * part of this suite, and nothing here signs in or types a credential.
 */

interface Fixture {
  url: string;
  close(): Promise<void>;
  /** Prompts the page actually submitted to the backend. */
  readonly prompts: string[];
  setReply(text: string): void;
  setChunkDelay(ms: number): void;
}

const STYLE = "body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto}[hidden]{display:none!important}";

const CHAT_SCRIPT = `
  const conv = document.querySelector('[data-testid="conversation"]');
  const box = document.querySelector('#prompt-textarea');
  const stop = document.querySelector('[data-testid="stop-button"]');
  let busy = false;
  box.addEventListener('keydown', async (event) => {
    // Real composers submit on Enter and insert a line break on Shift+Enter.
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      box.value += '\\n';
      return;
    }
    if (event.key !== 'Enter' || busy || !box.value) return;
    event.preventDefault();
    const prompt = box.value;
    box.value = '';
    busy = true;
    stop.hidden = false;
    const user = document.createElement('div');
    user.dataset.messageAuthorRole = 'user';
    user.textContent = prompt;
    conv.appendChild(user);
    const reply = document.createElement('div');
    reply.dataset.messageAuthorRole = 'assistant';
    // A markdown reply keeps its line breaks; innerText must not flatten a code fence.
    reply.style.whiteSpace = 'pre-wrap';
    conv.appendChild(reply);
    const body = await (await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })).json();
    for (const word of String(body.reply).split(/(\\s+)/).filter(Boolean)) {
      await new Promise((r) => setTimeout(r, body.chunk_delay_ms));
      reply.textContent += word;
    }
    stop.hidden = true;
    busy = false;
  });
`;

function chatPage(composer: string, extra = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock consumer chat</title><style>${STYLE}</style></head>
<body>
<button data-testid="model-selector" aria-label="Choose model">mock-model-x</button>
<div data-testid="conversation"></div>
${composer}
<button data-testid="stop-button" aria-label="Stop response" hidden>Stop</button>
${extra}
<script>${CHAT_SCRIPT}</script>
</body></html>`;
}

const TEXTAREA = '<textarea id="prompt-textarea" aria-label="Message"></textarea>';

async function startFixture(): Promise<Fixture> {
  let reply = "Echo: hello there";
  let chunkDelayMs = 20;
  const prompts: string[] = [];

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock.local");
    if (req.method === "POST" && url.pathname === "/api/prompt") {
      const body = JSON.parse(await readBody(req)) as { prompt?: unknown };
      prompts.push(String(body.prompt ?? ""));
      return sendJson(res, { reply, chunk_delay_ms: chunkDelayMs });
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    switch (url.pathname) {
      case "/":
        return sendHtml(res, chatPage(TEXTAREA));
      case "/readonly":
        // The box is there but swallows typing: a composer that never received the
        // prompt must not be treated as a submitted turn.
        return sendHtml(res, chatPage('<textarea id="prompt-textarea" aria-label="Message" readonly></textarea>'));
      case "/altbox":
        return sendHtml(res, chatPage('<textarea data-testid="box" aria-label="Message"></textarea>'));
      case "/landing":
        // Live behaviour on grok.com and chat.qwen.ai: a visitor with no session gets a
        // working-looking composer plus sign-in controls, which the composer check alone
        // would happily call "signed in".
        return sendHtml(
          res,
          chatPage(TEXTAREA, '<button>Log in</button><button>Sign up</button>'),
        );
      case "/login":
        return sendHtml(
          res,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title><style>${STYLE}</style></head>
<body><h1>Sign in to your account</h1><form><input name="email" type="email"><button type="submit">Continue</button></form></body></html>`,
        );
      case "/challenge":
        return sendHtml(
          res,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checking</title><style>${STYLE}</style></head>
<body><div class="cf-challenge">Verify you are human to continue.</div></body></html>`,
        );
      default:
        res.writeHead(404).end();
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    get prompts() {
      return prompts;
    },
    setReply: (text) => (reply = text),
    setChunkDelay: (ms) => (chunkDelayMs = ms),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A definition aimed at the fixture instead of a provider host. */
function definitionAt(fixture: Fixture, path: string): AccountSiteDefinition {
  return { ...ACCOUNT_SITE_DEFINITIONS.chatgpt, startUrl: `${fixture.url}${path}`, loginUrl: `${fixture.url}/login` };
}

let fixture: Fixture;
let browser: Browser;

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser.close();
  await fixture.close();
});

async function on(path: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${fixture.url}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

async function failure(fn: () => Promise<unknown>): Promise<BridgeError> {
  return await fn().then(
    () => {
      throw new Error("expected a BridgeError");
    },
    (err) => err as BridgeError,
  );
}

describe("shipped account site definitions", () => {
  it("declares buffered streaming for every site, because none is proven native", () => {
    for (const [key, definition] of Object.entries(ACCOUNT_SITE_DEFINITIONS)) {
      const connector = new AccountSiteConnector(definition);
      expect(connector.streaming).toBe("buffered");
      expect(connector.id).toBe(key);
      expect(connector.consumption).toBe("free_quota");
    }
  });

  it("names the provider's own https hosts and lists candidates for every control", () => {
    for (const definition of Object.values(ACCOUNT_SITE_DEFINITIONS)) {
      expect(definition.startUrl).toMatch(/^https:\/\//);
      expect(definition.loginUrl).toMatch(/^https:\/\//);
      for (const group of ["composer", "assistant", "stop", "model"] as const) {
        expect(definition[group].length, `${definition.id}.${group}`).toBeGreaterThan(0);
        for (const selector of definition[group]) expect(selector.length).toBeGreaterThan(0);
      }
    }
  });

  it("maps its own field names onto the groups bridge selectors writes", () => {
    const groups = accountSelectorGroups(ACCOUNT_SITE_DEFINITIONS.qwen);
    expect(Object.keys(groups).sort()).toEqual(["assistant_message", "challenge", "composer", "model_picker", "stop_button"]);
    expect(groups.composer).toEqual(ACCOUNT_SITE_DEFINITIONS.qwen.composer);
    expect(groups.assistant_message).toEqual(ACCOUNT_SITE_DEFINITIONS.qwen.assistant);
    expect(groups.stop_button).toEqual(ACCOUNT_SITE_DEFINITIONS.qwen.stop);
    expect(groups.model_picker).toEqual(ACCOUNT_SITE_DEFINITIONS.qwen.model);
    // A copy, so tuning one connector cannot edit the shipped definition.
    groups.composer.push("#leaked");
    expect(ACCOUNT_SITE_DEFINITIONS.qwen.composer).not.toContain("#leaked");
  });

  it("replaces a group wholesale from the owner's selectors, and leaves the rest alone", () => {
    const connector = new AccountSiteConnector(ACCOUNT_SITE_DEFINITIONS.grok, "free_quota", {
      assistant_message: ['[data-probe="reply"]'],
    });
    expect(connector.selectors.assistant_message).toEqual(['[data-probe="reply"]']);
    expect(connector.selectors.composer).toEqual(ACCOUNT_SITE_DEFINITIONS.grok.composer);
    // An empty list is not an override: it would silently un-select everything.
    const untouched = new AccountSiteConnector(ACCOUNT_SITE_DEFINITIONS.grok, "free_quota", { assistant_message: [] });
    expect(untouched.selectors.assistant_message).toEqual(ACCOUNT_SITE_DEFINITIONS.grok.assistant);
  });
});

describe("account site connector against a controlled page", () => {
  it("reports a signed-in composer, and refuses a sign-in page that has none", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/"));
    const page = await on("/");
    try {
      expect(await connector.isSignedIn(page)).toBe(true);
      expect(await connector.detectChallenge(page)).toBe(false);
      expect(await connector.modelLabel(page)).toBe("mock-model-x");
    } finally {
      await page.close();
    }

    const signedOut = await on("/login");
    try {
      expect(await connector.isSignedIn(signedOut)).toBe(false);
    } finally {
      await signedOut.close();
    }
  }, 60_000);

  it("does not mistake a landing page's composer for a signed-in session", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/landing"));
    const page = await on("/landing");
    try {
      expect(await connector.isSignedIn(page)).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("submits one turn and reads the finished reply", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/"));
    const page = await on("/");
    try {
      const before = fixture.prompts.length;
      await connector.submitPrompt(page, "hello there");
      const reply = await connector.readReply(page, { signal: AbortSignal.timeout(30_000) });
      expect(reply.text).toBe("Echo: hello there");
      expect(reply.finish_reason).toBe("stop");
      expect(fixture.prompts.slice(before)).toEqual(["hello there"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("refuses to submit when the composer did not take the prompt", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/readonly"));
    const page = await on("/readonly");
    try {
      const before = fixture.prompts.length;
      const error = await failure(() => connector.submitPrompt(page, "this text is being swallowed"));
      expect(error.code).toBe("provider_error");
      expect(error.details.generation_started).toBe(false);
      expect(fixture.prompts.length).toBe(before);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("hands a human check back to the owner instead of touching it", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/challenge"));
    const page = await on("/challenge");
    try {
      const before = fixture.prompts.length;
      expect(await connector.detectChallenge(page)).toBe(true);
      const error = await failure(() => connector.submitPrompt(page, "must not be sent"));
      expect(error.code).toBe("login_required");
      expect(error.details.generation_started).toBe(false);
      expect(fixture.prompts.length).toBe(before);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("recognises the interstitial while its body is still empty", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/challenge"));
    const page = await browser.newPage();
    try {
      // No URL marker and no widget yet: the title is the only signal that survives.
      await page.setContent("<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>");
      expect(await connector.detectChallenge(page)).toBe(true);

      await page.setContent("<!doctype html><html><head><title>Grok</title></head><body></body></html>");
      expect(await connector.detectChallenge(page)).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reports a page with no composer as a sign-in problem, not as a provider error", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/login"));
    const page = await on("/login");
    try {
      const before = fixture.prompts.length;
      const error = await failure(() => connector.submitPrompt(page, "must not be sent"));
      expect(error.code).toBe("login_required");
      expect(error.details.generation_started).toBe(false);
      expect(error.details.provider).toBe("ChatGPT (your browser session)");
      expect(fixture.prompts.length).toBe(before);
    } finally {
      await page.close();
    }
  }, 90_000);

  it("reports a site-side limit as quota_exhausted", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/"));
    const page = await on("/");
    fixture.setReply("You've reached your usage limit. Try again later.");
    try {
      await connector.submitPrompt(page, "hello");
      const error = await failure(() => connector.readReply(page, { signal: AbortSignal.timeout(30_000) }));
      expect(error.code).toBe("quota_exhausted");
      expect(error.message).toContain("ChatGPT (your browser session)");
    } finally {
      fixture.setReply("Echo: hello there");
      await page.close();
    }
  }, 60_000);

  it("counts only this turn's reply, so an older message is never returned as the answer", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/"));
    const page = await on("/");
    try {
      await connector.submitPrompt(page, "first turn");
      await connector.readReply(page, { signal: AbortSignal.timeout(30_000) });

      fixture.setReply("Echo: second turn");
      await connector.submitPrompt(page, "second turn");
      const reply = await connector.readReply(page, { signal: AbortSignal.timeout(30_000) });
      expect(reply.text).toBe("Echo: second turn");
      expect(await page.locator('[data-message-author-role="assistant"]').count()).toBe(2);
      fixture.setReply("Echo: hello there");
    } finally {
      await page.close();
    }
  }, 90_000);

  it("uses the owner's selector override when the shipped guesses miss the layout", async () => {
    const page = await on("/altbox");
    try {
      const guessed = new AccountSiteConnector(definitionAt(fixture, "/altbox"));
      expect(await guessed.isSignedIn(page)).toBe(false);

      const tuned = new AccountSiteConnector(definitionAt(fixture, "/altbox"), "free_quota", {
        composer: ['[data-testid="box"]'],
      });
      expect(await tuned.isSignedIn(page)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("stops generation by clicking the page's own control, and says nothing when there is none", async () => {
    const connector = new AccountSiteConnector(definitionAt(fixture, "/"));
    const page = await on("/");
    try {
      await connector.stopGeneration(page);
      expect(await page.locator('[data-testid="stop-button"]').isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("account site connector through the route-A engine", () => {
  it("serves a turn end to end and declares the model as the page does, never as verified", async () => {
    const adapter = new BrowserChatAdapter({
      connector: new AccountSiteConnector(definitionAt(fixture, "/")),
      profileDir: mkdtempSync(join(tmpdir(), "ownai-account-")),
      mode: "background",
      launch: async () => browser.newContext(),
    });
    const before = fixture.prompts.length;
    try {
      const result = await adapter.generate(
        { model: "default", messages: [{ role: "user", content: "hello there" }], params: {} },
        { signal: AbortSignal.timeout(60_000) },
      );
      expect(result.text).toBe("Echo: hello there");
      expect(result.model).toBe("mock-model-x");
      expect(result.model_confidence).toBe("provider_declared");
      expect(adapter.sessionState).toBe("ready");
      expect(fixture.prompts.slice(before)).toEqual(["hello there"]);
    } finally {
      await adapter.close();
    }
  }, 120_000);

  it("reads a tool call out of the page reply for an account site the owner opted in", async () => {
    // The four consumer sites share one connector, so the text protocol has to work on
    // this route too — not only on the Claude one it was built against.
    const adapter = new BrowserChatAdapter({
      connector: new AccountSiteConnector(definitionAt(fixture, "/")),
      profileDir: mkdtempSync(join(tmpdir(), "ownai-account-tools-")),
      mode: "background",
      promptTools: true,
      launch: async () => browser.newContext(),
    });
    fixture.setReply('Checking now.\n```ownai_tool\n{"name":"get_weather","arguments":{"city":"Ankara"}}\n```');
    const before = fixture.prompts.length;
    try {
      expect(adapter.capabilities().tools).toBe("emulated");
      const result = await adapter.generate(
        {
          model: "default",
          messages: [{ role: "user", content: "weather in Ankara?" }],
          params: {},
          tools: [
            {
              type: "function",
              function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
            },
          ],
        },
        { signal: AbortSignal.timeout(60_000) },
      );

      expect(result.tool_calls?.map((call) => call.function.name)).toEqual(["get_weather"]);
      expect(result.finish_reason).toBe("tool_calls");
      // The block is handed to the client as a call, never left in the prose.
      expect(result.text).toBe("Checking now.");
      // A multi-line prompt is one submission: Enter inside it must not send early.
      expect(fixture.prompts.slice(before)).toHaveLength(1);
      expect(fixture.prompts[before]).toContain("ownai_tool");
      expect(fixture.prompts[before]).toContain("weather in Ankara?");
    } finally {
      await adapter.close();
    }
  }, 120_000);

  it("reports a signed-out site as login_required before any prompt is submitted", async () => {
    const adapter = new BrowserChatAdapter({
      connector: new AccountSiteConnector(definitionAt(fixture, "/login")),
      profileDir: mkdtempSync(join(tmpdir(), "ownai-account-out-")),
      mode: "automatic",
      launch: async () => browser.newContext(),
    });
    const before = fixture.prompts.length;
    try {
      const error = await failure(() =>
        adapter.generate(
          { model: "default", messages: [{ role: "user", content: "must not be sent" }], params: {} },
          { signal: AbortSignal.timeout(60_000) },
        ),
      );
      expect(error.code).toBe("login_required");
      expect(error.details.generation_started).toBe(false);
      expect(adapter.sessionState).toBe("needs_login");
      expect(await adapter.health()).toMatchObject({ state: "needs_login" });
      expect(fixture.prompts.length).toBe(before);
    } finally {
      await adapter.close();
    }
  }, 120_000);

  it("offers no tools, vision or sampling, and streams only what the page shows", () => {
    const adapter = new BrowserChatAdapter({
      connector: new AccountSiteConnector(ACCOUNT_SITE_DEFINITIONS.deepseek),
      profileDir: mkdtempSync(join(tmpdir(), "ownai-account-caps-")),
      mode: "background",
      launch: async () => browser.newContext(),
    });
    const caps = adapter.capabilities();
    expect(caps.streaming).toBe("buffered");
    expect(caps.tools).toBe("none");
    expect(caps.vision).toBe(false);
    expect(caps.json_mode).toBe(false);
    expect(caps.sampling_params).toEqual([]);
    expect(caps.system_role).toBe("emulated");
    expect(caps.multi_turn).toBe("flattened");
    expect(adapter.type).toBe("browser:deepseek");
    expect(adapter.kind).toBe("consumer_web");
  });
});

describe("read-only session check", () => {
  /**
   * health() answers from local state, so a browser route that has never been started
   * says "ready" while knowing nothing. probe() is the one that opens the page, and it
   * must leave nothing behind: the profile belongs to the owner's own browser.
   */
  function trackedAdapter(path: string, profile: string) {
    const opened: BrowserContext[] = [];
    let closed = 0;
    const adapter = new BrowserChatAdapter({
      connector: new AccountSiteConnector(definitionAt(fixture, path)),
      profileDir: profile,
      mode: "background",
      launch: async () => {
        const context = await browser.newContext();
        opened.push(context);
        context.on("close", () => closed++);
        return context;
      },
    });
    return { adapter, opened, closedNow: () => closed };
  }

  it("says ready without checking, until it is asked to check", async () => {
    const { adapter } = trackedAdapter("/", mkdtempSync(join(tmpdir(), "ownai-probe-0-")));
    try {
      expect(await adapter.health()).toMatchObject({ state: "ready" });
      expect((await adapter.health()).detail).toContain("Browser not started");
    } finally {
      await adapter.close();
    }
  }, 60_000);

  it("confirms a signed-in site, then closes the window it opened", async () => {
    const { adapter, opened, closedNow } = trackedAdapter("/", mkdtempSync(join(tmpdir(), "ownai-probe-1-")));
    const before = fixture.prompts.length;
    try {
      const health = await adapter.probe(AbortSignal.timeout(30_000));
      expect(health.state).toBe("ready");
      expect(health.detail).toContain("Signed in");
      expect(adapter.sessionState).toBe("ready");
      expect(opened.length).toBe(1);
      expect(closedNow()).toBe(1);
      expect(fixture.prompts.length).toBe(before);
      // The verdict is remembered, so a later health() no longer guesses.
      expect(await adapter.health()).toMatchObject({ state: "ready" });
    } finally {
      await adapter.close();
    }
  }, 120_000);

  it("reports a signed-out site as needing the owner, without submitting anything", async () => {
    const { adapter, closedNow } = trackedAdapter("/login", mkdtempSync(join(tmpdir(), "ownai-probe-2-")));
    const before = fixture.prompts.length;
    try {
      const health = await adapter.probe(AbortSignal.timeout(30_000));
      expect(health.state).toBe("needs_login");
      expect(health.detail).toContain("sign in");
      expect(adapter.sessionState).toBe("needs_login");
      expect((await adapter.health()).state).toBe("needs_login");
      expect(closedNow()).toBe(1);
      expect(fixture.prompts.length).toBe(before);
    } finally {
      await adapter.close();
    }
  }, 120_000);

  it("hands a verification step back to the owner instead of touching it", async () => {
    const { adapter } = trackedAdapter("/challenge", mkdtempSync(join(tmpdir(), "ownai-probe-3-")));
    const before = fixture.prompts.length;
    try {
      const health = await adapter.probe(AbortSignal.timeout(30_000));
      expect(health.state).toBe("needs_login");
      expect(health.detail).toContain("verification step");
      expect(adapter.sessionState).toBe("challenge");
      expect(fixture.prompts.length).toBe(before);
    } finally {
      await adapter.close();
    }
  }, 120_000);

  it("reports a browser that will not open as unavailable, not as a provider failure", async () => {
    const adapter = new BrowserChatAdapter({
      connector: new AccountSiteConnector(definitionAt(fixture, "/")),
      profileDir: mkdtempSync(join(tmpdir(), "ownai-probe-4-")),
      mode: "background",
      launch: async () => {
        throw new Error("Opening in existing browser session. --user-data-dir=C:/Users/me/Brave");
      },
    });
    try {
      const health = await adapter.probe(AbortSignal.timeout(30_000));
      expect(health.state).toBe("provider_unavailable");
      // The raw automation message carries the owner's profile path; it must not surface.
      expect(health.detail).not.toContain("C:/Users/me");
      expect(health.detail).not.toContain("--user-data-dir");
    } finally {
      await adapter.close();
    }
  }, 60_000);
});
