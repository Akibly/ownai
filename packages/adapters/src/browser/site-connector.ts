import type { Consumption, FinishReason } from "@ownai/contracts";
import type { Page } from "playwright";

/**
 * Types a prompt into a chat composer. Enter submits on these sites, and
 * `keyboard.type` presses it for every `\n` — so a multi-line prompt (any tool turn,
 * or just a prompt with two paragraphs) would be submitted piece by piece. Line
 * breaks go in as Shift+Enter, which every one of these composers reads as newline.
 */
export async function typePrompt(page: Page, prompt: string): Promise<void> {
  const lines = prompt.split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press("Shift+Enter");
    if (line.length > 0) await page.keyboard.type(line, { delay: 0 });
  }
}

export interface ReadOptions {
  signal: AbortSignal;
  /** Called with the full reply text observed so far, each time it changes. */
  onProgress?: (textSoFar: string) => void;
}

export interface SiteReply {
  text: string;
  finish_reason: FinishReason;
}

/**
 * Page-specific knowledge for one chat website. The browser engine owns everything
 * else: profiles, modes, serialization, deadlines, cancellation and normalization.
 *
 * Rules for implementations:
 *  - The user signs in manually to their own isolated profile on their own device.
 *  - Never use another person's account or serve their traffic through a personal route.
 *  - No bot-detection evasion, fingerprint spoofing, CAPTCHA handling or rate-limit
 *    circumvention. When the site presents a challenge, report it via detectChallenge
 *    and let the user resolve it in visible mode.
 */
export interface SiteConnector {
  /** Stable ID, used in the adapter type "browser:<id>". */
  readonly id: string;
  readonly displayName: string;
  readonly startUrl: string;
  readonly loginUrl: string;
  readonly consumption: Consumption;
  /**
   * "native" only when the page appends reply text monotonically while generating,
   * so observed growth is genuine incremental output.
   */
  readonly streaming: "native" | "buffered";

  isSignedIn(page: Page): Promise<boolean>;
  /** True when the site is showing a verification challenge that needs a human. */
  detectChallenge(page: Page): Promise<boolean>;
  /** Start a fresh conversation so earlier turns do not leak into this request. */
  newConversation(page: Page): Promise<void>;
  submitPrompt(page: Page, prompt: string): Promise<void>;
  /** Wait for the reply to finish. Must throw BridgeError for site-reported failures. */
  readReply(page: Page, options: ReadOptions): Promise<SiteReply>;
  /** Ask the site to stop generating, if it offers a way. */
  stopGeneration(page: Page): Promise<void>;
  /** Model name the page displays, or null. Displayed names are provider_declared, never verified. */
  modelLabel(page: Page): Promise<string | null>;
}
