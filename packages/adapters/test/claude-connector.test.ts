import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeConnector, inspectClaude, isChallengeUrl } from "../src/index.ts";

/**
 * Selector and diagnostics tests against a local HTML fixture, not claude.ai.
 * The live DOM check is a separate, owner-driven step.
 */

const FIXTURE = `<!doctype html><html><body>
  <div contenteditable="true" data-testid="chat-input" aria-label="Message"></div>
  <div data-testid="assistant-message" class="font-claude-message">
    <span class="header">Claude responded:</span>
    <div class="prose"><p>the reply alone</p></div>
    <span class="stamp">just now</span>
  </div>
  <button aria-label="Stop generating">Stop</button>
  <button data-testid="model-picker">Sonnet</button>
  <section class="weird-layout-reply">not guessed by any default</section>
  <textarea name="something-else" placeholder="Ask anything"></textarea>
</body></html>`;

let context: BrowserContext;

/** A composer that appends a fresh reply on Enter, with one reply already on screen. */
const TURN_FIXTURE = `<!doctype html><html><body>
  <div data-testid="assistant-message"><div class="prose">answer from the previous turn</div></div>
  <div contenteditable="true" data-testid="chat-input"></div>
  <script>
    const box = document.querySelector('[data-testid="chat-input"]');
    box.addEventListener('keydown', (event) => {
      if (event.key !== "Enter") return;
      const message = document.createElement('div');
      message.setAttribute('data-testid', 'assistant-message');
      const prose = document.createElement('div');
      prose.className = 'prose';
      prose.textContent = 'answer to this turn';
      message.append(prose);
      document.body.append(message);
      box.textContent = '';
    });
  </script>
</body></html>`;

beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ownai-inspect-")), { headless: true });
}, 60_000);

afterAll(async () => {
  await context.close();
});

describe("claude connector selectors", () => {
  it("merges per-group overrides by replacing the whole list", () => {
    const connector = new ClaudeConnector({ selectors: { composer: ['[data-testid="real-box"]'] } });
    expect(connector.selectors.composer).toEqual(['[data-testid="real-box"]']);
    expect(connector.selectors.stop_button.length).toBeGreaterThan(0);
  });

  it("defaults to buffered streaming, because native is only claimed once proven", () => {
    expect(new ClaudeConnector().streaming).toBe("buffered");
    expect(new ClaudeConnector({ streaming: "native" }).streaming).toBe("native");
  });

  it("inspect reports which default selectors actually match", async () => {
    const page = await context.newPage();
    await page.setContent(FIXTURE);
    const report = await inspectClaude(page);

    expect(report.groups.composer.some((hit) => hit.includes("chat-input"))).toBe(true);
    expect(report.groups.assistant_message.length).toBeGreaterThan(0);
    expect(report.groups.stop_button.length).toBeGreaterThan(0);
    expect(report.groups.challenge).toEqual([]);
    await page.close();
  });

  it("inspect reports the text each reply candidate would return", async () => {
    const page = await context.newPage();
    await page.setContent(FIXTURE);
    const report = await inspectClaude(page);

    const container = report.text_candidates.find((entry) => entry.selector === '[data-testid="assistant-message"]');
    const narrow = report.text_candidates.filter((entry) => entry.preview === "the reply alone");

    // The container matches, but its text carries page chrome — which is exactly the
    // trap a bare match count hides. The report has to show both sides.
    expect(container?.preview).toContain("Claude responded:");
    expect(container?.preview).toContain("just now");
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.every((entry) => entry.selector.startsWith('[data-testid="assistant-message"] '))).toBe(true);
    expect(narrow.some((entry) => entry.selector.includes("div.prose"))).toBe(true);
    await page.close();
  });

  it("inspect also inventories elements no default selector guessed", async () => {
    const page = await context.newPage();
    await page.setContent(FIXTURE);
    const report = await inspectClaude(page);

    // The odd reply container is invisible to the defaults but visible in the inventory.
    expect(report.inventory.some((entry) => entry.selector.includes("weird-layout-reply"))).toBe(true);
    expect(report.inventory.some((entry) => entry.role === "composer_candidate")).toBe(true);
    expect(report.inventory.some((entry) => entry.role === "control_candidate")).toBe(true);
    await page.close();
  });

  it("inspect honours the same overrides the connector would use", async () => {
    const page = await context.newPage();
    await page.setContent(FIXTURE);
    const report = await inspectClaude(page, { composer: ['[data-testid="does-not-exist"]'] });
    expect(report.groups.composer).toEqual([]);
    await page.close();
  });

  it("names a verification interstitial as one, so the advice is not 'fix your selectors'", () => {
    expect(isChallengeUrl("https://claude.ai/new?__cf_chl_rt_tk=abc-123")).toBe(true);
    expect(isChallengeUrl("https://claude.ai/cdn-cgi/challenge-platform/h/b/orchestrate/xyz")).toBe(true);
    expect(isChallengeUrl("https://claude.ai/chat/8f4dc477-6484")).toBe(false);
    expect(isChallengeUrl("https://claude.ai/login")).toBe(false);
  });

  it("reads this turn's reply, not one that was already on the page", async () => {
    const page = await context.newPage();
    await page.setContent(TURN_FIXTURE);
    const connector = new ClaudeConnector({
      selectors: { assistant_message: ['[data-testid="assistant-message"] div.prose'] },
    });

    await connector.submitPrompt(page, "answer this");
    const reply = await connector.readReply(page, { signal: AbortSignal.timeout(20_000) });

    // The previous turn's reply is still visible when this one is submitted. Reading
    // whichever element matched first returned that stale text as a fresh answer.
    expect(reply.text).toBe("answer to this turn");
    await page.close();
  }, 60_000);

  it("refuses to submit when the composer did not receive the prompt", async () => {
    const page = await context.newPage();
    // Shaped like the composer but not editable: keystrokes land nowhere, so pressing
    // Enter would send whatever stale text the box really holds.
    await page.setContent('<div data-testid="chat-input">an old draft</div>');
    const connector = new ClaudeConnector();

    await expect(connector.submitPrompt(page, "a brand new prompt that cannot land in this box")).rejects.toMatchObject({
      code: "provider_error",
    });
    await page.close();
  }, 60_000);

  it("collapses a model label the site wraps across lines", async () => {
    const page = await context.newPage();
    await page.setContent('<button data-testid="model-picker">Sonnet 5.5<br>Medium</button>');
    expect(await new ClaudeConnector().modelLabel(page)).toBe("Sonnet 5.5 Medium");
    await page.close();
  });

  it("clicks the stop control the live site actually uses", async () => {
    const page = await context.newPage();
    await page.setContent('<button data-testid="chat-input-stop" onclick="window.__stopped = true">Stop</button>');

    // Verified from a live turn: this testid is visible while Claude writes and gone
    // once it finishes, so it is both the completion signal and the abort control.
    await new ClaudeConnector().stopGeneration(page);
    expect(await page.evaluate("window.__stopped === true")).toBe(true);
    await page.close();
  });

  it("detects a challenge from the URL alone, before its DOM says anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ownai-chl-"));
    const file = join(dir, "__cf_chl_rt_tk.html");
    writeFileSync(file, FIXTURE);
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href);

    // The fixture has a composer, so a URL-only check is what keeps a human check
    // from being reported as "you are signed out" or "the selectors are stale".
    expect(await new ClaudeConnector().isSignedIn(page)).toBe(true);
    expect(await new ClaudeConnector().detectChallenge(page)).toBe(true);
    await page.close();
  });
});
