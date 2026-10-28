import { BridgeError } from "@ownai/contracts";
import type { Page } from "playwright";
import { sleep } from "../abort.ts";
import type { ReadOptions, SiteConnector, SiteReply } from "./site-connector.ts";

const POLL_MS = 50;

/** Connector for apps/mock-chat, the project's own controlled test site. */
export class MockChatConnector implements SiteConnector {
  readonly id = "mock-chat";
  readonly displayName = "Mock Chat (test site)";
  readonly consumption = "none" as const;
  readonly streaming = "native" as const;
  readonly startUrl: string;
  readonly loginUrl: string;

  constructor(baseUrl: string) {
    this.startUrl = new URL("/", baseUrl).href;
    this.loginUrl = new URL("/login", baseUrl).href;
  }

  async isSignedIn(page: Page): Promise<boolean> {
    if (new URL(page.url()).pathname === "/login") return false;
    if (await page.getByTestId("login-required").isVisible()) return false;
    return (await page.getByTestId("prompt").count()) > 0;
  }

  async detectChallenge(): Promise<boolean> {
    return false; // The mock site never challenges.
  }

  async newConversation(page: Page): Promise<void> {
    await page.getByTestId("new-chat").click();
  }

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    await page.getByTestId("prompt").fill(prompt);
    await page.getByTestId("send").click();
  }

  async readReply(page: Page, { signal, onProgress }: ReadOptions): Promise<SiteReply> {
    const reply = page.locator('.msg[data-role="assistant"]').last();
    await reply.waitFor({ state: "attached" });
    let last = "";
    for (;;) {
      const [text, state, error] = await reply.evaluate((el: HTMLElement) => [
        el.textContent ?? "",
        el.dataset.state ?? "",
        el.dataset.error ?? "",
      ]);
      if (text !== last) {
        last = text;
        onProgress?.(text);
      }
      if (state === "done") return { text, finish_reason: "stop" };
      if (state === "error") throw siteError(error);
      if (state === "stopped") throw new BridgeError("cancelled", "Generation was stopped.", { generation_started: true });
      await sleep(POLL_MS, signal);
    }
  }

  async stopGeneration(page: Page): Promise<void> {
    const stop = page.getByTestId("stop");
    if (await stop.isEnabled()) await stop.click();
  }

  async modelLabel(page: Page): Promise<string | null> {
    const label = page.getByTestId("model-label");
    return (await label.count()) ? ((await label.textContent())?.trim() ?? null) : null;
  }
}

function siteError(code: string): BridgeError {
  switch (code) {
    case "login_required":
      return new BridgeError("login_required", "The site session expired. Sign in again in visible mode.", {
        generation_started: false,
      });
    case "quota_exhausted":
      return new BridgeError("quota_exhausted", "The site reports the account's usage limit is reached.", {
        generation_started: false,
      });
    default:
      return new BridgeError("provider_error", "The site reported an error while generating.", {
        generation_started: true,
      });
  }
}
