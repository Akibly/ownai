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
import { buildToolBlock, parseToolReply } from "./tool-protocol.ts";

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
  /**
   * Offer tool calling as a text protocol, for a site with no tool interface of its
   * own. Off unless the owner turns it on, because it asks a chat page to follow a
   * format and a page can decline.
   */
  promptTools?: boolean;
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

/** Long enough for the owner to see Brave's approval prompt and answer it. */
const ATTACH_APPROVAL_TIMEOUT_MS = 120_000;

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
  private readonly promptTools: boolean;
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
    this.promptTools = options.promptTools ?? false;
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
      tools: this.promptTools ? "emulated" : "none",
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

  /**
   * A chat page has no tool interface, so "the model must call this" cannot be
   * guaranteed and is refused rather than approximated. "none" is honoured by simply
   * not offering the functions.
   */
  private toolInstructions(request: AdapterRequest): string {
    if (!this.promptTools || !request.tools?.length) return "";
    if (request.tool_choice === "none") return "";
    if (request.tool_choice !== undefined && request.tool_choice !== "auto") {
      throw new BridgeError(
        "unsupported_feature",
        'This connection asks the page to follow a text protocol, so it can only honour tool_choice "auto" or "none".',
        { capability: "tool_choice" },
      );
    }
    return buildToolBlock(request.tools);
  }

  async generate(request: AdapterRequest, ctx: GenerateContext): Promise<AdapterResult> {
    // Settled before the browser opens: a tool choice this route cannot honour is the
    // client's to fix, and refusing it should cost neither a window nor a turn.
    const instructions = this.toolInstructions(request);
    let started = false;
    try {
      return await this.mutex.run(async () => {
        throwIfAborted(ctx.signal, false);
        const page = await this.openPage(this.mode === "visible" ? false : true);
        await this.ensureOnStartPage(page);
        if (process.env.OWNAI_DEBUG_BROWSER === "1") console.error(`[browser] opened ${page.url()}`);

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
        await this.connector.submitPrompt(page, flattenMessages(request.messages, instructions));
        if (process.env.OWNAI_DEBUG_BROWSER === "1") console.error(`[browser] submitted on ${page.url()}`);
        started = true;

        const stop = () => void this.connector.stopGeneration(page).catch(() => {});
        ctx.signal.addEventListener("abort", stop, { once: true });
        // A reply that carries the protocol is withheld until it is parsed: half a JSON
        // block is not a callable thing, and no client should see raw protocol as prose.
        const streaming = this.connector.streaming === "native" && instructions.length === 0;
        let emitted = "";
        let rewritten = false;
        try {
          const reply = await this.connector.readReply(page, {
            signal: ctx.signal,
            onProgress: (text) => {
              if (!streaming || !ctx.onDelta || rewritten) return;
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
          if (rest && ctx.onDelta && streaming) ctx.onDelta({ text: rest });

          const parsed = instructions ? parseToolReply(reply.text, request.tools ?? []) : undefined;
          const calls = parsed?.calls ?? [];
          if (process.env.OWNAI_DEBUG_BROWSER === "1") {
            console.error(
              `[browser] reply_len=${reply.text.length} tools=${request.tools?.length ?? 0} instructions=${instructions.length} calls=${calls.length}`,
            );
          }
          const label = await this.connector.modelLabel(page);
          return {
            text: parsed ? parsed.prose : reply.text,
            finish_reason: calls.length > 0 ? "tool_calls" : reply.finish_reason,
            model: label ?? request.model,
            model_confidence: label ? "provider_declared" : "unknown",
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
            // A native route that had to wait for the whole reply to find a call streamed
            // as buffered this turn, so the label follows what the client actually got.
            ...(this.connector.streaming === "native" && instructions.length > 0 ? { streaming: "buffered" as const } : {}),
          } satisfies AdapterResult;
        } finally {
          ctx.signal.removeEventListener("abort", stop);
        }
      }, ctx.signal);
    } catch (err) {
      if (process.env.OWNAI_DEBUG_BROWSER === "1") {
        const detail = err as Error | null;
        console.error(`[browser] generate failed: ${detail?.name ?? "Error"}: ${String(detail?.message ?? err).split("\n")[0]}`);
      }
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
            // Brave asks the owner to approve each debugger connection, so the wait
            // includes a person noticing the prompt and clicking it.
            timeout: ATTACH_APPROVAL_TIMEOUT_MS,
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
        // Suppressed by default because raw Playwright text can carry profile paths and
        // command lines; the owner opts in when a failure has no other explanation.
        if (process.env.OWNAI_DEBUG_BROWSER === "1") {
          const detail = err as Error | null;
          console.error(`[browser] ${detail?.name ?? "Error"}: ${String(detail?.message ?? err).split("\n")[0]}`);
        }
        // An installed browser hands a second launch off to the window that already
        // owns the profile, which otherwise surfaces as an unexplained failure.
        // Playwright's own text carries the whole command line, so report in ours.
        if (this.attachToBrave && /timeout \d+ms exceeded/i.test(String((err as Error | null)?.message ?? ""))) {
          throw new BridgeError(
            "provider_unavailable",
            "Brave did not answer its debugger port. If Brave is asking whether to allow remote debugging, approve that prompt; otherwise enable the toggle at brave://inspect/#remote-debugging.",
            { generation_started: false },
          );
        }
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
export function flattenMessages(messages: NormalizedMessage[], instructions = ""): string {
  const only = messages[0];
  // One user turn needs no labels. The protocol block forces the full form, because the
  // model has to be able to tell its own past calls from a user's words.
  if (messages.length === 1 && only?.role === "user" && instructions.length === 0) return only.content ?? "";
  const label = { system: "Instructions", user: "User", assistant: "Assistant", tool: "Tool result" } as const;
  // A tool turn arrives with only an id, so the name comes from the call it answers.
  const called = new Map<string, string>();
  for (const message of messages) for (const call of message.tool_calls ?? []) called.set(call.id, call.function.name);

  const turns = messages.map((message) => {
    if (message.role === "tool") {
      const name = message.name ?? (message.tool_call_id ? called.get(message.tool_call_id) : undefined);
      return `[${label.tool}${name ? ` ${name}` : ""}]\n${message.content ?? ""}`;
    }
    // Past calls are written in the same block the model is asked to answer with, so
    // the history itself shows the format rather than describing it once.
    const calls = (message.tool_calls ?? [])
      .map((call) => `\`\`\`ownai_tool\n${JSON.stringify({ name: call.function.name, arguments: asJson(call.function.arguments) })}\n\`\`\``)
      .join("\n");
    return [
      `[${label[message.role]}]`,
      ...(message.content ? [message.content] : []),
      ...(calls ? [calls] : []),
    ].join("\n");
  });

  const history = turns.join("\n\n");
  return instructions.length > 0 ? `${instructions}\n\n${history}` : history;
}

/** Arguments travel as a string; a page reads them best as the object they came from. */
function asJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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
