import { BridgeError, type Consumption, type FinishReason } from "@ownai/contracts";
import type { Page } from "playwright";
import { sleep } from "../abort.ts";
import { claudeSelectorGroups, type SelectorGroup } from "./claude-connector.ts";
import type { ReadOptions, SiteConnector, SiteReply } from "./site-connector.ts";

/**
 * Personal, visible-browser connectors for consumer chat sites.
 *
 * These connectors only use ordinary page controls. They do not read cookies,
 * call private endpoints, defeat challenges, disguise automation, or skip a
 * provider limit. A provider challenge is returned as login_required for the
 * account owner to handle in the visible browser.
 */
export interface AccountSiteDefinition {
  id: "chatgpt" | "grok" | "qwen" | "deepseek";
  displayName: string;
  startUrl: string;
  loginUrl: string;
  composer: string[];
  assistant: string[];
  stop: string[];
  model: string[];
  challenge?: string[];
}

export const ACCOUNT_SITE_DEFINITIONS: Record<AccountSiteDefinition["id"], AccountSiteDefinition> = {
  chatgpt: {
    id: "chatgpt",
    displayName: "ChatGPT (your browser session)",
    startUrl: "https://chatgpt.com/",
    loginUrl: "https://chatgpt.com/auth/login",
    composer: ['#prompt-textarea', '[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]'],
    assistant: ['[data-message-author-role="assistant"]', '[data-testid*="conversation-turn"] [data-message-author-role="assistant"]'],
    stop: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="stop"]'],
    model: ['button[data-testid*="model-selector"]', 'button[aria-label*="model"]'],
  },
  grok: {
    id: "grok",
    displayName: "Grok (your browser session)",
    startUrl: "https://grok.com/",
    loginUrl: "https://grok.com/",
    composer: ['textarea[aria-label*="Ask"]', 'textarea[placeholder*="Ask"]', '[contenteditable="true"][role="textbox"]', "textarea"],
    assistant: ['[data-testid="message"]', '[data-testid*="assistant"]', '.message-bubble'],
    stop: ['button[aria-label*="Stop"]', 'button[aria-label*="stop"]', '[data-testid*="stop"]'],
    model: ['button[aria-label*="model"]', '[data-testid*="model-selector"]'],
  },
  qwen: {
    id: "qwen",
    displayName: "Qwen (your browser session)",
    startUrl: "https://chat.qwen.ai/",
    loginUrl: "https://chat.qwen.ai/",
    composer: ['textarea[placeholder*="Message"]', '[contenteditable="true"][role="textbox"]', "textarea"],
    assistant: ['.message-content', '.markdown-body', '[data-testid*="assistant"]'],
    stop: ['button[aria-label*="Stop"]', 'button[aria-label*="stop"]', '[data-testid*="stop"]'],
    model: ['button[aria-label*="model"]', '[data-testid*="model-selector"]'],
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek (your browser session)",
    startUrl: "https://chat.deepseek.com/",
    loginUrl: "https://chat.deepseek.com/",
    composer: ['textarea[placeholder*="Message"]', '[contenteditable="true"][role="textbox"]', "textarea"],
    assistant: ['.ds-markdown', '[data-testid*="assistant"]', '.markdown'],
    stop: ['button[aria-label*="Stop"]', 'button[aria-label*="stop"]', '[data-testid*="stop"]'],
    model: ['button[aria-label*="model"]', '[data-testid*="model-selector"]'],
  },
};

const CHALLENGE_TEXT = ["verify you are human", "checking your browser", "confirm you are not a robot", "unusual traffic"];
const QUOTA_TEXT = [/usage limit/i, /hit your limit/i, /try again (at|later|in)/i, /you've reached/i, /daily limit/i, /quota/i];
const POLL_MS = 250;
const STABLE_POLLS = 6;

/**
 * The definition's own field names mapped onto the group names `bridge inspect`
 * and `bridge selectors` use, so one command tunes any browser site.
 */
export function accountSelectorGroups(definition: AccountSiteDefinition): Record<SelectorGroup, string[]> {
  return {
    composer: [...definition.composer],
    assistant_message: [...definition.assistant],
    stop_button: [...definition.stop],
    model_picker: [...definition.model],
    challenge: [...(definition.challenge ?? [])],
  };
}

export function selectorGroupsForType(type: string): Record<SelectorGroup, string[]> | null {
  if (type === "browser:claude") return claudeSelectorGroups();
  if (!type.startsWith("browser:")) return null;
  const id = type.slice("browser:".length);
  if (!Object.hasOwn(ACCOUNT_SITE_DEFINITIONS, id)) return null;
  return accountSelectorGroups(ACCOUNT_SITE_DEFINITIONS[id as AccountSiteDefinition["id"]]);
}

export class AccountSiteConnector implements SiteConnector {
  readonly id: string;
  readonly displayName: string;
  readonly startUrl: string;
  readonly loginUrl: string;
  readonly consumption: Consumption;
  readonly streaming = "buffered" as const;
  readonly selectors: Record<SelectorGroup, string[]>;
  private turnAnchor = 0;

  constructor(
    readonly definition: AccountSiteDefinition,
    consumption: Consumption = "free_quota",
    overrides: Partial<Record<SelectorGroup, string[]>> = {},
  ) {
    this.id = definition.id;
    this.displayName = definition.displayName;
    this.startUrl = definition.startUrl;
    this.loginUrl = definition.loginUrl;
    this.consumption = consumption;
    this.selectors = accountSelectorGroups(definition);
    // A replacement, not an append: after a layout change a stale default can match
    // an unrelated element, and `selectors` is how the owner gets out of that.
    for (const [group, list] of Object.entries(overrides)) {
      if (list && list.length > 0) this.selectors[group as SelectorGroup] = [...list];
    }
  }

  async isSignedIn(page: Page): Promise<boolean> {
    if (/\/(login|sign-in|signin)(?:\/|$)/i.test(new URL(page.url()).pathname)) return false;
    return (await this.find(page, this.selectors.composer)) !== null;
  }

  async detectChallenge(page: Page): Promise<boolean> {
    if (/__cf_chl|\/cdn-cgi\/challenge-platform|\/_sec\/challenge/i.test(page.url())) return true;
    const selectors = [...this.selectors.challenge, 'iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="captcha"]', '[class*="cf-challenge"]'];
    if (await this.anyVisible(page, selectors)) return true;
    const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    return CHALLENGE_TEXT.some((marker) => body.toLowerCase().includes(marker));
  }

  async newConversation(page: Page): Promise<void> {
    await page.goto(this.startUrl, { waitUntil: "domcontentloaded" });
    await this.waitForComposer(page);
  }

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await this.waitForComposer(page);
    await composer.click();
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.type(prompt, { delay: 0 });
    const actual = (await composer.inputValue().catch(() => composer.innerText().catch(() => ""))).replace(/\s+/g, " ").trim();
    const sentinel = prompt.slice(-24).replace(/\s+/g, " ").trim();
    if (!actual.includes(sentinel)) {
      throw new BridgeError("provider_error", "The composer did not receive the prompt, so nothing was submitted.", {
        generation_started: false,
        provider: this.displayName,
      });
    }
    this.turnAnchor = await this.replyCount(page);
    await page.keyboard.press("Enter");
  }

  async readReply(page: Page, { signal, onProgress }: ReadOptions): Promise<SiteReply> {
    const reply = await this.waitForReply(page, signal);
    let previous = "";
    let stable = 0;
    for (;;) {
      const text = (await reply.innerText().catch(() => "")).trim();
      if (text !== previous) {
        previous = text;
        stable = 0;
        onProgress?.(text);
      } else if (text.length > 0) stable++;

      const generating = await this.anyVisible(page, this.selectors.stop_button);
      if (!generating && stable >= STABLE_POLLS) {
        if (!text) throw new BridgeError("provider_error", "The page produced no reply text.", { generation_started: true });
        if (QUOTA_TEXT.some((re) => re.test(text))) {
          throw new BridgeError("quota_exhausted", `${this.displayName} reports that the account has reached its usage limit.`, {
            generation_started: false,
            provider: this.displayName,
          });
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
    const text = (await picker.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    return text.length > 0 && text.length < 60 ? text : null;
  }

  private async waitForComposer(page: Page) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = await this.find(page, this.selectors.composer);
      if (found) return found;
      if (await this.detectChallenge(page)) {
        throw new BridgeError("login_required", "The site is asking for a human check. Complete it in the visible browser.", { generation_started: false });
      }
      await sleep(POLL_MS, AbortSignal.timeout(10_000));
    }
    throw new BridgeError("login_required", `No message composer is visible for ${this.displayName}. Sign in in visible mode.`, {
      generation_started: false,
      provider: this.displayName,
    });
  }

  private async waitForReply(page: Page, signal: AbortSignal) {
    for (let attempt = 0; attempt < 120; attempt++) {
      for (const selector of this.selectors.assistant_message) {
        const locator = page.locator(selector);
        if ((await locator.count().catch(() => 0)) > this.turnAnchor) return locator.last();
      }
      if (await this.detectChallenge(page)) {
        throw new BridgeError("login_required", "The site is asking for a human check. Complete it in the visible browser.", {
          generation_started: true,
          provider: this.displayName,
        });
      }
      await sleep(POLL_MS, signal);
    }
    throw new BridgeError("timeout", `No reply appeared from ${this.displayName}.`, { generation_started: true });
  }

  private async replyCount(page: Page): Promise<number> {
    let highest = 0;
    for (const selector of this.selectors.assistant_message) highest = Math.max(highest, await page.locator(selector).count().catch(() => 0));
    return highest;
  }

  private async find(page: Page, selectors: readonly string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0) return locator;
    }
    return null;
  }

  private async firstVisible(page: Page, selectors: readonly string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) return locator;
    }
    return null;
  }

  private async anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
    return (await this.firstVisible(page, selectors)) !== null;
  }
}

function finishReasonFor(text: string): FinishReason {
  return text.length > 0 ? "stop" : null;
}
