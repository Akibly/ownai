import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "@ownai/contracts";
import { startMockChat, type MockChatServer } from "@ownai/mock-chat";
import type { BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserChatAdapter, MockChatConnector } from "../src/index.ts";

/**
 * End-to-end for the route-A engine against the project's own controlled test site.
 * Chromium is launched headless here; a real provider site is never part of the suite.
 *
 * One browser, one sign-in for the whole file: a cold launch costs several seconds on
 * Windows, and the profile persisting across the sign-in window closing is itself a
 * behaviour under test (ADR-015).
 */

let site: MockChatServer;
let browser: BrowserChatAdapter;

beforeAll(async () => {
  site = await startMockChat({ chunkDelayMs: 15 });
  browser = new BrowserChatAdapter({
    connector: new MockChatConnector(site.url),
    profileDir: mkdtempSync(join(tmpdir(), "ownai-profile-")),
    mode: "background",
  });
  // The bridge opens the provider's own page and never submits a credential itself;
  // here the test plays the human's part.
  await browser.interactiveLogin({
    headless: true,
    onPage: async (page: Page) => {
      await page.getByTestId("login-username").fill("tester");
      await page.getByTestId("login-submit").click();
    },
  });
}, 120_000);

afterAll(async () => {
  await browser.close();
  await site.close();
});

function request(prompt: string) {
  return { model: "default", messages: [{ role: "user" as const, content: prompt }], params: {} };
}

async function failure(fn: () => Promise<unknown>): Promise<BridgeError> {
  return await fn().then(
    () => {
      throw new Error("expected a BridgeError");
    },
    (err) => err as BridgeError,
  );
}

describe("browser chat adapter", () => {
  it("is signed in after the window closes, from the persisted profile", async () => {
    expect(browser.sessionState).toBe("ready");
    const result = await browser.generate(request("hello there"), { signal: AbortSignal.timeout(30_000) });
    expect(result.text).toBe("Echo: hello there");
    expect(result.finish_reason).toBe("stop");
    // The site displays a name; the bridge can only report it as declared, never verified.
    expect(result.model).toBe("mock-model-1");
    expect(result.model_confidence).toBe("provider_declared");
  }, 60_000);

  it("streams native increments in order", async () => {
    site.setChunkDelay(70);
    const deltas: string[] = [];
    const result = await browser.generate(request("one two three four five"), {
      signal: AbortSignal.timeout(30_000),
      onDelta: (delta) => deltas.push(delta.text ?? ""),
    });
    site.setChunkDelay(15);
    expect(deltas.join("")).toBe(result.text);
    expect(result.text).toBe("Echo: one two three four five");
    expect(deltas.length).toBeGreaterThan(1);
  }, 60_000);

  it("T06: an expired session is reported as login_required before the prompt is sent", async () => {
    await browser.generate(request("warm up"), { signal: AbortSignal.timeout(30_000) });
    const before = site.promptCount;

    site.expireSessions();
    const error = await failure(() => browser.generate(request("must not be sent"), { signal: AbortSignal.timeout(30_000) }));

    expect(error.code).toBe("login_required");
    expect(error.details.generation_started).toBe(false);
    expect(site.promptCount).toBe(before);
    expect(browser.sessionState).toBe("needs_login");

    // Re-authenticate for the tests that follow, the way a user would in visible mode.
    await signInAgain();
  }, 90_000);

  it("reports a site-side usage limit as quota_exhausted, not as a generic failure", async () => {
    site.setQuotaExhausted(true);
    const error = await failure(() => browser.generate(request("hi"), { signal: AbortSignal.timeout(30_000) }));
    site.setQuotaExhausted(false);
    expect(error.code).toBe("quota_exhausted");
  }, 60_000);

  it("cancels a live generation and tells the caller the prompt already went out", async () => {
    site.setChunkDelay(150);
    const controller = new AbortController();
    const before = site.promptCount;
    const pending = browser.generate(request("alpha beta gamma delta epsilon zeta"), { signal: controller.signal });

    // Abort once the site actually has the prompt, so this tests mid-stream
    // cancellation rather than racing a cold browser launch.
    for (let waited = 0; site.promptCount === before && waited < 20_000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }
    controller.abort();

    const error = await failure(() => pending);
    site.setChunkDelay(15);
    expect(error.code).toBe("cancelled");
    expect(error.details.generation_started).toBe(true);
  }, 90_000);

  it("serializes concurrent turns instead of sharing one page", async () => {
    const [a, b] = await Promise.all([
      browser.generate(request("first"), { signal: AbortSignal.timeout(40_000) }),
      browser.generate(request("second"), { signal: AbortSignal.timeout(40_000) }),
    ]);
    expect([a.text, b.text].sort()).toEqual(["Echo: first", "Echo: second"]);
  }, 120_000);

  it("declares no tool, vision or sampling support, because the page has none", () => {
    const caps = browser.capabilities();
    expect(caps.tools).toBe(false);
    expect(caps.vision).toBe(false);
    expect(caps.sampling_params).toEqual([]);
    expect(caps.system_role).toBe("emulated");
    expect(caps.multi_turn).toBe("flattened");
    expect(caps.context_window).toBeNull();
  });

  it("flattens multi-turn history into the single box a chat site offers", async () => {
    const result = await browser.generate(
      {
        model: "default",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "again" },
        ],
        params: {},
      },
      { signal: AbortSignal.timeout(30_000) },
    );
    expect(result.text).toContain("[Instructions]");
    expect(result.text).toContain("again");
  }, 60_000);

  it("closes at the browser level when the context refuses, so the profile is not left locked", async () => {
    let browserClosed = 0;
    const stuck = {
      on: () => {},
      pages: () => [],
      newPage: async () => {
        throw new Error("window is gone");
      },
      close: async () => {
        throw new Error("close refused");
      },
      browser: () => ({
        close: async () => {
          browserClosed++;
        },
      }),
    } as unknown as BrowserContext;

    const adapter = new BrowserChatAdapter({
      connector: new MockChatConnector(site.url),
      profileDir: mkdtempSync(join(tmpdir(), "ownai-stuck-")),
      mode: "background",
      launch: async () => stuck,
    });

    const err = await failure(() => adapter.generate(request("x"), { signal: AbortSignal.timeout(10_000) }));
    expect(err.code).toBe("provider_unavailable");
    expect(browserClosed).toBe(1);
  }, 30_000);

  it("names the owning window when the profile is already taken, without leaking the command line", async () => {
    const adapter = new BrowserChatAdapter({
      connector: new MockChatConnector(site.url),
      profileDir: mkdtempSync(join(tmpdir(), "ownai-busy-")),
      mode: "background",
      launch: async () => {
        throw new Error(
          "browserType.launchPersistentContext: Opening in existing browser session. " +
            'This usually means that the profile is already in use by another instance of Chromium.\n' +
            "<launching> C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe --user-data-dir=C:/Users/me/User Data",
        );
      },
    });

    const err = await failure(() => adapter.generate(request("x"), { signal: AbortSignal.timeout(10_000) }));
    expect(err.code).toBe("provider_unavailable");
    expect(err.message).toContain("already owns this browser profile");
    expect(err.message).not.toContain("brave.exe");
  }, 30_000);
});

async function signInAgain(): Promise<void> {
  await browser.interactiveLogin({
    headless: true,
    onPage: async (page: Page) => {
      await page.getByTestId("login-username").fill("tester");
      await page.getByTestId("login-submit").click();
    },
  });
}
