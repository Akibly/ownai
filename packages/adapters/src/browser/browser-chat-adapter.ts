import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError, isBridgeError, type AdapterCapabilities } from "@ownai/contracts";
import type { Browser, BrowserContext, Page } from "playwright";
import { abortError, sleep, throwIfAborted } from "../abort.ts";
import { Mutex } from "../mutex.ts";
import type {
  AdapterHealth,
  AdapterModel,
  AdapterRequest,
  AdapterResult,
  GenerateContext,
  NormalizedMessage,
  ProviderAdapter,
} from "../types.ts";
import type { SiteConnector } from "./site-connector.ts";

/**
 * visible:    headed window, for sign-in, debugging and transparency.
 * background: headless, same isolated persistent profile.
 * automatic:  background; when the site needs the user (sign-in or a challenge),
 *             fail with login_required and ask the user to open visible mode.
 *             It never tries to complete a challenge itself (ADR-015).
 */
export type BrowserMode = "visible" | "background" | "automatic";

export type SessionState = "closed" | "ready" | "needs_login" | "challenge";

export type LaunchFn = (profileDir: string, options: { headless: boolean }) => Promise<BrowserContext>;

export interface BrowserChatAdapterOptions {
  connector: SiteConnector;
  /** Isolated per-connection profile directory. Never shared between connections. */
  profileDir: string;
  mode: BrowserMode;
  /** Browser channel, e.g. "msedge" to use the installed Edge instead of Playwright's Chromium. */
  channel?: string;
  /** Explicit installed-browser executable, for browsers Playwright does not name as a channel. */
  executablePath?: string;
  /** Attach to the user's default Brave profile using its user-enabled local DevTools port. */
  attachToBrave?: boolean;
  /** Override browser launching (tests). */
  launch?: LaunchFn;
}

export interface InteractiveLoginOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Force headless. Only for automated tests that sign in to the mock site. */
  headless?: boolean;
  /** Receives the login page; used by tests to play the user's part. */
  onPage?: (page: Page) => Promise<void>;
}

const LOGIN_POLL_MS = 250;

export class BrowserChatAdapter implements ProviderAdapter {
  readonly type: string;
  readonly provider: string;
  readonly kind = "consumer_web" as const;
  readonly consumption;

  private readonly connector: SiteConnector;
  private readonly profileDir: string;
  private readonly launchFn: LaunchFn;
  private readonly mutex = new Mutex();
  private mode: BrowserMode;
  private context: BrowserContext | null = null;
  private attachedBrowser: Browser | null = null;
  private attachedPage: Page | null = null;
  private readonly attachToBrave: boolean;
  private contextHeadless = true;
  private state: SessionState = "closed";

  constructor(options: BrowserChatAdapterOptions) {
    this.connector = options.connector;
    this.profileDir = options.profileDir;
    this.mode = options.mode;
    this.type = `browser:${options.connector.id}`;
    this.provider = options.connector.displayName;
    this.consumption = options.connector.consumption;
    this.attachToBrave = options.attachToBrave ?? false;
    this.launchFn = options.launch ?? defaultLaunch(options.channel, options.executablePath);
  }

  get sessionState(): SessionState {
    return this.state;
  }

  get currentMode(): BrowserMode {
    return this.mode;
  }

  /** Switching mode closes the current window; the next request relaunches with the same profile. */
  async setMode(mode: BrowserMode): Promise<void> {
    await this.mutex.run(async () => {
      this.mode = mode;
      await this.closeContext();
    });
  }

  capabilities(): AdapterCapabilities {
    return {
      text_input: true,
      text_output: true,
      system_role: "emulated",
      multi_turn: "flattened",
      streaming: this.connector.streaming,
      tools: false,
      vision: false,
      json_mode: false,
      // Chat UIs do not expose sampling controls, so none are accepted.
      sampling_params: [],
      context_window: null,
    };
  }

  async listModels(): Promise<AdapterModel[]> {
    // The site chooses the model; the bridge cannot verify it.
    return [{ id: "default", confidence: "unknown" }];
  }

  async health(): Promise<AdapterHealth> {
    switch (this.state) {
      case "needs_login":
        return { state: "needs_login", detail: "Open this connection in visible mode and sign in." };
      case "challenge":
        return { state: "needs_login", detail: "The site is asking for verification. Open visible mode." };
      case "closed":
        return { state: "ready", detail: "Browser not started; sign-in status is checked on first use." };
      default:
        return { state: "ready" };
    }
  }

  /**
   * Opens the site read-only to answer "could this connection serve a turn right now?".
   * It navigates and looks: it never types, never clicks send and never submits a
   * prompt, so it spends no turn and cannot start a generation.
   *
   * The window is closed afterwards. Sign-in lives in the profile on disk, not in the
   * live window, so closing loses nothing — and leaving one open would keep holding a
   * profile the owner may want to use in their own browser.
   */
  async probe(signal?: AbortSignal): Promise<AdapterHealth> {
    let session: SessionState = "closed";
    let result: AdapterHealth;
    try {
      result = await this.mutex.run(async () => {
        if (signal) throwIfAborted(signal, false);
        const page = await this.openPage(this.mode !== "visible");
        await this.ensureOnStartPage(page);
        if (await this.connector.detectChallenge(page)) {
          session = "challenge";
          return {
            state: "needs_login",
            detail: `${this.provider} is showing a verification step. Open visible mode and complete it yourself.`,
          };
        }
        if (await this.safeIsSignedIn(page)) {
          session = "ready";
          return { state: "ready", detail: `Signed in at ${this.provider}.` };
        }
        session = "needs_login";
        return {
          state: "needs_login",
          detail: `${this.provider} shows no message composer. Open visible mode and sign in.`,
        };
      }, signal);
    } catch (err) {
      if (isBridgeError(err)) {
        if (err.code === "login_required") session = "needs_login";
        result = {
          state: err.code === "login_required" ? "needs_login" : err.code === "quota_exhausted" ? "quota_exhausted" : "provider_unavailable",
          detail: err.message,
        };
      } else {
        // A window that will not open is this machine's problem, not the provider's, and
        // the raw message can carry profile paths or a command line.
        result = { state: "provider_unavailable", detail: "The browser could not open this site to check it." };
      }
    }
    await this.mutex.run(async () => {
      await this.closeContext().catch(() => {});
      this.state = session;
    });
    return result;
  }

  async generate(request: AdapterRequest, ctx: GenerateContext): Promise<AdapterResult> {
    let started = false;
    try {
      return await this.mutex.run(async () => {
        throwIfAborted(ctx.signal, false);
        const page = await this.openPage(this.mode === "visible" ? false : true);
        await this.ensureOnStartPage(page);

        if (await this.connector.detectChallenge(page)) {
          this.state = "challenge";
          throw new BridgeError("login_required", "The site needs you to complete a verification step in visible mode.", {
            generation_started: false,
          });
        }
        if (!(await this.connector.isSignedIn(page))) {
          this.state = "needs_login";
          throw new BridgeError("login_required", "This connection is signed out. Open it in visible mode and sign in.", {
            generation_started: false,
          });
        }
        this.state = "ready";
        throwIfAborted(ctx.signal, false);

        await this.connector.newConversation(page);
        await this.connector.submitPrompt(page, flattenMessages(request.messages));
        started = true;

        const stop = () => void this.connector.stopGeneration(page).catch(() => {});
        ctx.signal.addEventListener("abort", stop, { once: true });
        let emitted = "";
        let rewritten = false;
        try {
          const reply = await this.connector.readReply(page, {
            signal: ctx.signal,
            onProgress: (text) => {
              if (this.connector.streaming !== "native" || !ctx.onDelta || rewritten) return;
              if (!text.startsWith(emitted)) {
                rewritten = true;
                return;
              }
              const delta = text.slice(emitted.length);
              if (delta) {
                emitted = text;
                ctx.onDelta({ text: delta });
              }
            },
          });
          if (rewritten || !reply.text.startsWith(emitted)) {
            throw new BridgeError("provider_error", "The page changed text that had already been streamed.", {
              generation_started: true,
            });
          }
          const rest = reply.text.slice(emitted.length);
          if (rest && ctx.onDelta && this.connector.streaming === "native") ctx.onDelta({ text: rest });

          const label = await this.connector.modelLabel(page);
          return {
            text: reply.text,
            finish_reason: reply.finish_reason,
            model: label ?? request.model,
            model_confidence: label ? "provider_declared" : "unknown",
          } satisfies AdapterResult;
        } finally {
          ctx.signal.removeEventListener("abort", stop);
        }
      }, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) throw abortError(ctx.signal, started);
      if (isBridgeError(err)) {
        if (err.code === "login_required") this.state = "needs_login";
        throw err;
      }
      // A crash or externally closed window is not a provider-side error. Discard the
      // cached context so the next request starts a fresh one instead of failing forever.
      await this.closeContext().catch(() => {});
      this.state = "closed";
      // Browser/automation failures: report generically; raw messages can contain URLs or page text.
      throw new BridgeError(
        started ? "provider_error" : "provider_unavailable",
        started ? "The browser session failed while reading the reply." : "The browser session could not be started.",
        { generation_started: started },
      );
    }
  }

  /**
   * Opens the site's sign-in page so the user can sign in on the provider's own page.
   * Resolves once the connector reports a signed-in session. Afterwards, background and
   * automatic modes close the window and continue headless with the same profile.
   */
  async interactiveLogin(options: InteractiveLoginOptions = {}): Promise<void> {
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? 5 * 60_000),
    ]);
    await this.mutex.run(async () => {
      await this.closeContext();
      const page = await this.openPage(options.headless ?? false);
      await page.goto(this.connector.loginUrl);
      const helper = options.onPage?.(page);
      try {
        for (;;) {
          if (await this.safeIsSignedIn(page)) break;
          await sleep(LOGIN_POLL_MS, signal);
        }
      } catch {
        throw abortError(signal, false);
      }
      await helper;
      if (this.mode !== "visible") await this.closeContext();
      // Sign-in is a fact about the persisted profile, not about the live window, so
      // closing the headless window must not erase it.
      this.state = "ready";
    }, signal);
  }

  async close(): Promise<void> {
    await this.closeContext();
  }

  /**
   * Opens the site purely so a human can see what the connector would look at. It
   * submits nothing, clicks nothing and waits for nothing.
   */
  async openInspectPage(): Promise<Page> {
    return this.mutex.run(async () => {
      const page = await this.openPage(this.mode !== "visible");
      await this.ensureOnStartPage(page);
      return page;
    });
  }

  /** Returns the live page without navigating, so a just-completed reply can be inspected. */
  async inspectCurrentPage(): Promise<Page> {
    return this.mutex.run(async () => this.openPage(this.mode !== "visible"));
  }

  private async openPage(headless: boolean): Promise<Page> {
    if (!this.attachToBrave && this.context && this.contextHeadless !== headless) await this.closeContext();
    if (!this.context) {
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      let context: BrowserContext;
      try {
        if (this.attachToBrave) {
          const { chromium } = await import("playwright");
          const browser = await chromium.connectOverCDP(await braveDevToolsEndpoint(), {
            noDefaults: true,
            timeout: 30_000,
          });
          context = browser.contexts()[0]!;
          if (!context) {
            await browser.close();
            throw new BridgeError("provider_unavailable", "Brave has no attachable browser context.", {
              generation_started: false,
            });
          }
          this.attachedBrowser = browser;
          this.attachedPage = await context.newPage();
        } else {
          context = await this.launchFn(this.profileDir, { headless });
        }
      } catch (err) {
        const attached = this.attachedBrowser;
        this.attachedBrowser = null;
        this.attachedPage = null;
        if (attached) await attached.close().catch(() => {});
        // An installed browser hands a second launch off to the window that already
        // owns the profile, which otherwise surfaces as an unexplained failure.
        // Playwright's own text carries the whole command line, so report in ours.
        if (/existing browser session|already in use/i.test(String((err as Error | null)?.message ?? ""))) {
          throw new BridgeError(
            "provider_unavailable",
            "Another window already owns this browser profile. Close that browser completely, then retry.",
            { generation_started: false },
          );
        }
        throw err;
      }
      context.on("close", () => {
        if (this.context === context) {
          this.context = null;
          this.attachedBrowser = null;
          this.attachedPage = null;
          this.state = "closed";
        }
      });
      this.context = context;
      this.contextHeadless = this.attachToBrave ? false : headless;
    }
    return this.attachedPage ?? this.context.pages()[0] ?? (await this.context.newPage());
  }

  private async ensureOnStartPage(page: Page): Promise<void> {
    const start = new URL(this.connector.startUrl);
    const current = page.url() === "about:blank" ? null : new URL(page.url());
    if (!current || current.origin !== start.origin || current.pathname !== start.pathname) {
      await page.goto(this.connector.startUrl, { waitUntil: "domcontentloaded" });
    }
  }

  private async safeIsSignedIn(page: Page): Promise<boolean> {
    try {
      return await this.connector.isSignedIn(page);
    } catch {
      return false; // Page is mid-navigation.
    }
  }

  private async closeContext(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.state = "closed";
    if (this.attachedBrowser) {
      const page = this.attachedPage;
      const browser = this.attachedBrowser;
      this.attachedPage = null;
      this.attachedBrowser = null;
      await page?.close().catch(() => {});
      // A browser obtained through connectOverCDP disconnects; it does not own or
      // close the user's existing Brave instance or its other tabs.
      await browser.close().catch(() => {});
      return;
    }
    if (!context) return;
    try {
      await context.close();
    } catch {
      // A window that survives a refused close keeps the profile locked, and every
      // later request then fails the same opaque way. Close at the browser level.
      await context.browser()?.close().catch(() => {});
    }
  }
}

async function braveDevToolsEndpoint(): Promise<string> {
  const userDataDir =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "BraveSoftware", "Brave-Browser", "User Data")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser")
        : join(homedir(), ".config", "BraveSoftware", "Brave-Browser");
  let contents: string;
  try {
    contents = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
  } catch {
    throw new BridgeError(
      "provider_unavailable",
      "Brave's remote-debugging port is unavailable. Enable it in brave://inspect/#remote-debugging, then retry.",
      { generation_started: false },
    );
  }
  const [rawPort, rawPath] = contents.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^\/devtools\/browser\/[\w-]+$/.test(rawPath ?? "")) {
    throw new BridgeError("provider_unavailable", "Brave's local DevTools endpoint file is malformed.", {
      generation_started: false,
    });
  }
  return `ws://127.0.0.1:${port}${rawPath}`;
}

/** Serializes chat turns into one prompt, because chat UIs accept a single message. */
export function flattenMessages(messages: NormalizedMessage[]): string {
  const only = messages[0];
  // A browser route declares no tool support, so validation never lets a content-less
  // tool turn reach this function; the fallback only keeps the types honest.
  if (messages.length === 1 && only?.role === "user") return only.content ?? "";
  const label = { system: "Instructions", user: "User", assistant: "Assistant", tool: "Tool result" } as const;
  return messages.map((m) => `[${label[m.role]}]\n${m.content ?? ""}`).join("\n\n");
}

function defaultLaunch(channel: string | undefined, executablePath: string | undefined): LaunchFn {
  return async (profileDir, { headless }) => {
    const { chromium } = await import("playwright");
    return chromium.launchPersistentContext(profileDir, {
      headless,
      ...(channel ? { channel } : {}),
      ...(executablePath ? { executablePath } : {}),
      viewport: { width: 1200, height: 900 },
    });
  };
}
