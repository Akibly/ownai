import { BridgeError, type Consumption, type FinishReason } from "@ownai/contracts";
import type { Page } from "playwright";
import { sleep } from "../abort.ts";
import type { ReadOptions, SiteConnector, SiteReply } from "./site-connector.ts";

/**
 * Drives the user's own signed-in claude.ai session, on their own machine, through
 * their own browser profile.
 *
 * What this deliberately is not:
 *  - It never solves, bypasses or works around a challenge. If the site asks for a
 *    human, detectChallenge() reports it and automatic mode stops with
 *    login_required so the user can finish in visible mode.
 *  - No fingerprint or user-agent spoofing, no stealth patches, no proxy rotation,
 *    no cookie extraction, no multi-account pooling, no rate-limit circumvention.
 *  - It is not a server-side or shared-credential path. Serving anyone else's
 *    traffic through it is prohibited by the router unless a provider has given
 *    written permission, and nothing here changes that.
 *
 * Selectors are the brittle part of any site connector, so they are candidate lists
 * tried in order rather than one guess, and they can be overridden per connection
 * without a code change. inspectClaude() reports what is actually on the page,
 * including elements we never guessed at, and never clicks, types or submits.
 */

export type SelectorGroup = "composer" | "assistant_message" | "stop_button" | "model_picker" | "challenge";

export const SELECTOR_GROUPS: readonly SelectorGroup[] = [
  "composer",
  "assistant_message",
  "stop_button",
  "model_picker",
  "challenge",
];

const DEFAULT_SELECTORS: Record<SelectorGroup, string[]> = {
  composer: [
    '[data-testid="chat-input"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[name="message"]',
  ],
  assistant_message: ['[data-testid="assistant-message"]', ".font-claude-message", '[data-testid$="message-body"]'],
  stop_button: [
    '[data-testid="chat-input-stop"]',
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
  ],
  model_picker: ['[data-testid="model-picker"] button', '[data-testid="model-picker"]', 'button[aria-label*="model"]'],
  challenge: [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="captcha"]',
    '[class*="cf-challenge"]',
    'input[name*="captcha"]',
  ],
};

const CHALLENGE_TEXT = ["verify you are human", "checking your browser", "confirm you are not a robot", "unusual traffic"];

/** A copy of the shipped guesses, so tuning one connection cannot edit them for all. */
export function claudeSelectorGroups(): Record<SelectorGroup, string[]> {
  return {
    composer: [...DEFAULT_SELECTORS.composer],
    assistant_message: [...DEFAULT_SELECTORS.assistant_message],
    stop_button: [...DEFAULT_SELECTORS.stop_button],
    model_picker: [...DEFAULT_SELECTORS.model_picker],
    challenge: [...DEFAULT_SELECTORS.challenge],
  };
}

/**
 * A verification interstitial announces itself in the URL before its DOM renders
 * anything, so this is the earliest honest signal we get. Recognising it is not a
 * bypass: it exists so the bridge says "a human check is waiting" instead of
 * pointing the user at their selectors or their sign-in.
 */
const CHALLENGE_URL = [/__cf_chl/i, /\/cdn-cgi\/challenge-platform/i, /\/_sec\/challenge/i];

export function isChallengeUrl(url: string): boolean {
  return CHALLENGE_URL.some((re) => re.test(url));
}

/** Phrases that mean the account, not the bridge, has run out of room. */
const QUOTA_TEXT = [/usage limit/i, /hit your limit/i, /try again (at|later|in)/i, /you've reached/i, /daily limit/i];

const POLL_MS = 250;
/** Consecutive identical polls treated as "the page has finished writing". */
const STABLE_POLLS = 6;

export interface ClaudeConnectorOptions {
  /**
   * What a turn consumes on the account behind this connection. The page does not
   * state it reliably, so the owner declares it and the bridge only echoes it.
   */
  consumption?: Consumption;
  /**
   * "buffered" is the honest default: native streaming may only be claimed once a
   * repeatable test shows the reply grows monotonically (see SiteConnector).
   * Checked against a live claude.ai turn on 2026-10-27: the reply text appeared in a
   * single step, so buffered is currently an observation, not just caution.
   */
  streaming?: "native" | "buffered";
  /** Set only after an inspect-driven check confirms the new-conversation URL. */
  newChatUrl?: string;
  /** Per-group candidate lists, merged over the defaults. Use the inspect report to fill these. */
  selectors?: Partial<Record<SelectorGroup, string[]>>;
}

export class ClaudeConnector implements SiteConnector {
  readonly id = "claude";
  readonly displayName = "Claude (your own browser session)";
  readonly startUrl: string;
  readonly loginUrl = "https://claude.ai/login";
  readonly consumption: Consumption;
  readonly streaming: "native" | "buffered";
  readonly selectors: Record<SelectorGroup, string[]>;
  /** Reply elements counted just before Enter; anything beyond that is this turn's. */
  private turnAnchor = 0;

  constructor(options: ClaudeConnectorOptions = {}) {
    this.consumption = options.consumption ?? "free_quota";
    this.streaming = options.streaming ?? "buffered";
    this.startUrl = options.newChatUrl ?? "https://claude.ai/new";
    this.selectors = { ...DEFAULT_SELECTORS };
    // An override replaces a group's list entirely, so a stale default can never
    // match an unrelated element after the layout changes.
    for (const [group, list] of Object.entries(options.selectors ?? {})) {
      if (list && list.length > 0) this.selectors[group as SelectorGroup] = list;
    }
  }

  async isSignedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/\/(login|sign-in|register)/.test(url)) return false;
    if (url === "about:blank") return false;
    return (await this.find(page, this.selectors.composer)) !== null;
  }

  async detectChallenge(page: Page): Promise<boolean> {
    if (isChallengeUrl(page.url())) return true;
    if (await this.anyVisible(page, this.selectors.challenge)) return true;
    const body = await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "");
    const lower = body.toLowerCase();
    return CHALLENGE_TEXT.some((marker) => lower.includes(marker));
  }

  async newConversation(page: Page): Promise<void> {
    // Navigating to the site's own new-chat URL is more reliable than clicking a
    // sidebar control that may not exist for every account layout.
    await page.goto(this.startUrl, { waitUntil: "domcontentloaded" });
    await this.waitForComposer(page);
  }

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await this.waitForComposer(page);
    // A rich composer needs real keystrokes; fill() is rejected by contenteditable.
    await composer.click();
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.type(prompt, { delay: 0 });
    // Whatever is in the box is what the provider answers, so a leftover draft would
    // produce a confident reply to the wrong prompt. Verify before pressing Enter.
    const typed = (await composer.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!typed.includes(prompt.slice(-24).replace(/\s+/g, " ").trim())) {
      throw new BridgeError(
        "provider_error",
        "The composer did not receive this prompt, so nothing was submitted.",
        { generation_started: false, provider: this.displayName },
      );
    }
    // Counted after typing, before Enter: this is what "a reply to this turn" means.
    this.turnAnchor = await this.visibleReplyCount(page);
    await page.keyboard.press("Enter");
  }

  async readReply(page: Page, { signal, onProgress }: ReadOptions): Promise<SiteReply> {
    const message = await this.waitForTurnReply(page, signal);
    let last = "";
    let stable = 0;

    for (;;) {
      const text = await message.evaluate((el: HTMLElement) => el.innerText.trim());
      const quota = QUOTA_TEXT.some((re) => re.test(text));

      if (text !== last) {
        last = text;
        stable = 0;
        onProgress?.(text);
      } else if (text.length > 0) {
        stable++;
      }

      // Still generating: the site keeps its own stop control available.
      const generating = await this.anyVisible(page, this.selectors.stop_button);
      if (!generating && stable >= STABLE_POLLS) {
        if (text.length === 0) {
          throw new BridgeError("provider_error", "The page produced no reply text.", { generation_started: true });
        }
        if (quota) {
          throw new BridgeError(
            "quota_exhausted",
            "Claude reports this account has reached its usage limit. Wait for the reset the page states.",
            { generation_started: false, provider: this.displayName },
          );
        }
        return { text, finish_reason: finishReasonFor(text) };
      }
      await sleep(POLL_MS, signal);
    }
  }

  async stopGeneration(page: Page): Promise<void> {
    const stop = await this.firstVisible(page, this.selectors.stop_button);
    if (stop) await stop.click().catch(() => {});
  }

  async modelLabel(page: Page): Promise<string | null> {
    const picker = await this.firstVisible(page, this.selectors.model_picker);
    if (!picker) return null;
    // The picker can wrap the displayed name across lines; a model label has to be
    // a single line or clients render it as a broken id.
    const text = (await picker.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    // A displayed name is provider_declared only; the bridge cannot verify provenance.
    return text.length > 0 && text.length < 60 ? text : null;
  }

  private async waitForComposer(page: Page) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = await this.find(page, this.selectors.composer);
      if (found) return found;
      await sleep(250, AbortSignal.timeout(10_000));
    }
    throw new BridgeError(
      "login_required",
      "No message composer is visible. Open this connection in visible mode and check you are signed in. If you are signed in, run inspect: the composer selectors need updating.",
      { generation_started: false, provider: this.displayName },
    );
  }

  /**
   * The newest reply beyond the anchor taken before Enter, so a message that was
   * already on the page is never reported as this turn's answer.
   */
  private async currentTurnReply(page: Page) {
    for (const selector of this.selectors.assistant_message) {
      const locator = page.locator(selector);
      if ((await locator.count().catch(() => 0)) > this.turnAnchor) return locator.last();
    }
    return null;
  }

  private async visibleReplyCount(page: Page): Promise<number> {
    // Candidate lists nest (a container and a narrower element inside it), so the
    // highest count is the honest number of replies on the page.
    let highest = 0;
    for (const selector of this.selectors.assistant_message) {
      highest = Math.max(highest, await page.locator(selector).count().catch(() => 0));
    }
    return highest;
  }

  private async waitForTurnReply(page: Page, signal: AbortSignal) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const reply = await this.currentTurnReply(page);
      if (reply) return reply;
      if (await this.detectChallenge(page)) {
        throw new BridgeError("login_required", "Claude is asking for a human check. Finish it in visible mode.", {
          generation_started: true,
          provider: this.displayName,
        });
      }
      await sleep(POLL_MS, signal);
    }
    throw new BridgeError("timeout", "No reply text appeared on the page. Run inspect: the reply selectors may need updating.", {
      generation_started: true,
    });
  }

  private async find(page: Page, selectors: readonly string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) return locator;
    }
    return null;
  }

  private async firstVisible(page: Page, selectors: readonly string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator;
    }
    return null;
  }

  private async anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
    return (await this.firstVisible(page, selectors)) !== null;
  }
}

function finishReasonFor(text: string): FinishReason {
  // The page states no finish reason, so "stop" is reported and nothing stronger is claimed.
  return text.length > 0 ? "stop" : null;
}

export interface InspectReport {
  url: string;
  /** Present selectors per group, with match counts. Empty groups need new selectors. */
  groups: Record<SelectorGroup, string[]>;
  /**
   * Elements that look like a composer, a reply or a control, whether or not we
   * guessed them. This is what makes a fully-missed report still useful.
   */
  inventory: Array<{ role: string; selector: string; label: string; visible: boolean }>;
  /**
   * The text each assistant-message candidate would return, subtree included. A
   * container can match while its innerText carries page chrome (headers,
   * timestamps), so this is what tells a narrower selector from a lucky guess.
   */
  text_candidates: Array<{ selector: string; length: number; preview: string; leaf: boolean }>;
  note: string;
}

/**
 * Read-only diagnostics. Queries the DOM and returns a report; it never clicks,
 * types, submits or navigates. Run it against the signed-in page, then put the
 * right selectors into the connection's options.selectors.
 */
export async function inspectClaude(
  page: Page,
  overrides: Partial<Record<SelectorGroup, string[]>> = {},
  siteDefaults?: Record<SelectorGroup, string[]>,
): Promise<InspectReport> {
  const groups = {} as Record<SelectorGroup, string[]>;
  const defaults = siteDefaults ?? DEFAULT_SELECTORS;
  for (const group of Object.keys(DEFAULT_SELECTORS) as SelectorGroup[]) {
    const hits: string[] = [];
    for (const selector of overrides[group] ?? defaults[group] ?? DEFAULT_SELECTORS[group]!) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) hits.push(`${selector} (${count})`);
    }
    groups[group] = hits;
  }

  const inventory = (await page.evaluate(`(() => {
    const out = [];
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const describe = (el) => {
      const testId = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label") ?? "";
      const placeholder = el.getAttribute("placeholder") ?? "";
      const cls = typeof el.className === "string" ? el.className : "";
      const selector = testId
        ? '[data-testid="' + testId + '"]'
        : aria
          ? el.tagName.toLowerCase() + '[aria-label="' + aria + '"]'
          : cls.trim()
            ? el.tagName.toLowerCase() + "." + cls.trim().split(/\\s+/).slice(0, 2).join(".")
            : el.tagName.toLowerCase();
      return { selector, label: (aria || placeholder || testId || cls || "").slice(0, 80), visible: isVisible(el) };
    };
    const push = (role, el) => {
      if (out.length < 80) out.push({ role, ...describe(el) });
    };

    for (const el of Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea'))) {
      push("composer_candidate", el);
    }
    for (const el of Array.from(document.querySelectorAll("[data-testid]"))) {
      const id = el.getAttribute("data-testid") ?? "";
      if (/message|response|answer|composer|input|chat|conversation|stream/i.test(id)) push("testid_candidate", el);
    }
    for (const el of Array.from(document.querySelectorAll("button, [role='button']"))) {
      const label = (el.getAttribute("aria-label") ?? "") + " " + (el.textContent ?? "");
      if (/stop|send|new chat|model|retry|regenerate/i.test(label)) push("control_candidate", el);
    }
    const replyPattern = '[class*="message"], [class*="prose"], [class*="markdown"], [class*="reply"], [class*="response"], [class*="answer"], [class*="conversation"]';
    for (const el of Array.from(document.querySelectorAll(replyPattern))) {
      push("reply_candidate", el);
    }
    return out;
  })()`)) as InspectReport["inventory"];

  // The count suffix is report decoration, not part of the selector.
  const assistant = (groups.assistant_message[0] ?? "").replace(/ \(\d+\)$/, "");
  const textCandidates = assistant
    ? ((await page.evaluate(`(() => {
      const ROOT_SELECTOR = ${JSON.stringify(assistant)};
      const matched = document.querySelectorAll(ROOT_SELECTOR);
      const root = matched[matched.length - 1];
      const out = [];
      if (!root) return out;

      const pathOf = (el) => {
        const parts = [];
        let cur = el;
        while (cur && cur !== root) {
          const testId = cur.getAttribute("data-testid");
          if (testId) {
            parts.unshift('[data-testid="' + testId + '"]');
            break;
          }
          let name = cur.tagName.toLowerCase();
          // Only plain class names are usable as CSS; anything with a colon or
          // bracket (Tailwind arbitrary values) would be an invalid selector.
          const cls = (typeof cur.className === "string" ? cur.className.trim().split(/\\s+/) : []).filter(
            (c) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(c),
          );
          if (cls.length > 0) name += "." + cls.slice(0, 2).join(".");
          const sameTag = cur.parentNode
            ? Array.from(cur.parentNode.children).filter((c) => c.tagName === cur.tagName)
            : [];
          if (sameTag.length > 1) name += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
          parts.unshift(name);
          cur = cur.parentNode;
        }
        return parts.join(" > ");
      };

      const add = (el, selector) => {
        if (out.length >= 40) return;
        const text = (el.innerText || "").trim();
        if (text.length === 0) return;
        out.push({
          selector,
          length: text.length,
          preview: text.slice(0, 160).replace(/\\s+/g, " "),
          leaf: el.children.length === 0,
        });
      };

      add(root, ROOT_SELECTOR);
      for (const el of Array.from(root.querySelectorAll("*"))) add(el, ROOT_SELECTOR + " " + pathOf(el));
      return out;
    })()`))) as InspectReport["text_candidates"]
    : [];

  return {
    url: page.url(),
    groups,
    inventory,
    text_candidates: textCandidates,
    note:
      "Read-only. Empty groups mean the defaults missed; use inventory entries to write options.selectors for this connection. " +
      "Pick the assistant_message selector whose text_candidates preview is the reply alone, without chrome.",
  };
}
