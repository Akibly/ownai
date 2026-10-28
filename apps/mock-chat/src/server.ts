/**
 * Mock consumer chat website: the controlled target for the route-A browser engine.
 * It imitates the parts of a chat site that matter to an adapter (sign-in, a prompt box,
 * a reply that grows while streaming, a stop button, session expiry, usage limits)
 * and nothing else. It is a test fixture, not a model.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockChatOptions {
  port?: number;
  /** Delay between streamed words. */
  chunkDelayMs?: number;
}

export interface MockChatServer {
  url: string;
  close(): Promise<void>;
  /** Invalidate every session, as a provider would on logout or expiry. */
  expireSessions(): void;
  setChunkDelay(ms: number): void;
  setQuotaExhausted(exhausted: boolean): void;
  /** Number of prompts received; lets tests assert a prompt was or was not sent. */
  readonly promptCount: number;
  /** The last prompt received, so tests can assert what was typed rather than the echo. */
  readonly lastPrompt: string | undefined;
}

const MODEL_LABEL = "mock-model-1";
const COOKIE = "mc_session";

export async function startMockChat(options: MockChatOptions = {}): Promise<MockChatServer> {
  const sessions = new Set<string>();
  let chunkDelayMs = options.chunkDelayMs ?? 20;
  let quotaExhausted = false;
  let promptCount = 0;
  let lastPrompt: string | undefined;

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock-chat.local");
    const session = readCookie(req, COOKIE);
    const signedIn = session !== undefined && sessions.has(session);

    if (req.method === "GET" && url.pathname === "/login") {
      return sendHtml(res, LOGIN_PAGE);
    }
    if (req.method === "POST" && url.pathname === "/login") {
      const form = new URLSearchParams(await readBody(req));
      if (!form.get("username")) return sendHtml(res, LOGIN_PAGE, 400);
      const token = randomBytes(24).toString("base64url");
      sessions.add(token);
      res.writeHead(303, {
        // Persistent on purpose: a real provider keeps you signed in across browser
        // restarts, and the engine closes the window after sign-in by design (ADR-015).
        "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
        Location: "/",
      });
      return void res.end();
    }
    if (req.method === "POST" && url.pathname === "/logout") {
      if (session) sessions.delete(session);
      res.writeHead(303, { "Set-Cookie": `${COOKIE}=; Max-Age=0; Path=/`, Location: "/login" });
      return void res.end();
    }
    if (req.method === "GET" && url.pathname === "/") {
      if (!signedIn) {
        res.writeHead(303, { Location: "/login" });
        return void res.end();
      }
      return sendHtml(res, CHAT_PAGE);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!signedIn) return sendJson(res, 401, { error: "login_required" });
      if (quotaExhausted) return sendJson(res, 429, { error: "quota_exhausted" });
      const { prompt } = JSON.parse(await readBody(req)) as { prompt?: unknown };
      if (typeof prompt !== "string" || !prompt) return sendJson(res, 400, { error: "empty_prompt" });
      promptCount++;
      lastPrompt = prompt;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      let closed = false;
      res.on("close", () => (closed = true));
      for (const word of `Echo: ${prompt}`.split(/(\s+)/).filter(Boolean)) {
        if (closed) return;
        await new Promise((r) => setTimeout(r, chunkDelayMs));
        res.write(word);
      }
      return void res.end();
    }
    res.writeHead(404).end();
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    expireSessions: () => sessions.clear(),
    setChunkDelay: (ms) => (chunkDelayMs = ms),
    setQuotaExhausted: (v) => (quotaExhausted = v),
    get promptCount() {
      return promptCount;
    },
    get lastPrompt() {
      return lastPrompt;
    },
  };
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #ddd; padding-bottom: .5rem; }
  .msg { padding: .6rem .8rem; border-radius: 8px; margin: .5rem 0; white-space: pre-wrap; }
  .msg[data-role=user] { background: #eef2ff; }
  .msg[data-role=assistant] { background: #f4f4f5; }
  .msg[data-state=error] { background: #fef2f2; }
  textarea { width: 100%; min-height: 4rem; font: inherit; }
  [hidden] { display: none !important; }
  .banner { background: #fff7ed; border: 1px solid #fdba74; padding: .6rem; border-radius: 6px; }
`;

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock Chat – Sign in</title><style>${STYLE}</style></head>
<body><main>
  <h1>Mock Chat</h1>
  <p>Test site for the OwnAI browser engine. Any username works.</p>
  <form method="post" action="/login" data-testid="login-form">
    <label>Username <input name="username" data-testid="login-username" autocomplete="username" required></label>
    <button type="submit" data-testid="login-submit">Sign in</button>
  </form>
</main></body></html>`;

const CHAT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock Chat</title><style>${STYLE}</style></head>
<body>
<header>
  <strong>Mock Chat</strong>
  <span>Model: <span data-testid="model-label">${MODEL_LABEL}</span></span>
  <form method="post" action="/logout"><button data-testid="logout">Sign out</button></form>
</header>
<div class="banner" data-testid="login-required" role="alert" hidden>Your session expired. Please sign in again.</div>
<div class="banner" data-testid="quota-banner" role="alert" hidden>You've reached your usage limit.</div>
<main data-testid="conversation" aria-live="polite"></main>
<textarea data-testid="prompt" aria-label="Message"></textarea>
<button data-testid="send">Send</button>
<button data-testid="stop" disabled>Stop</button>
<button data-testid="new-chat">New chat</button>
<script>
  const conv = document.querySelector('[data-testid=conversation]');
  const promptEl = document.querySelector('[data-testid=prompt]');
  const sendBtn = document.querySelector('[data-testid=send]');
  const stopBtn = document.querySelector('[data-testid=stop]');
  let controller = null;

  function addMsg(role, text, state) {
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.role = role;
    el.dataset.state = state;
    el.textContent = text;
    conv.appendChild(el);
    return el;
  }

  document.querySelector('[data-testid=new-chat]').onclick = () => { conv.innerHTML = ''; };
  stopBtn.onclick = () => controller && controller.abort();

  sendBtn.onclick = async () => {
    const prompt = promptEl.value;
    if (!prompt || controller) return;
    promptEl.value = '';
    addMsg('user', prompt, 'done');
    const reply = addMsg('assistant', '', 'streaming');
    controller = new AbortController();
    sendBtn.disabled = true; stopBtn.disabled = false;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }), signal: controller.signal,
      });
      if (res.status === 401) {
        document.querySelector('[data-testid=login-required]').hidden = false;
        reply.dataset.state = 'error'; reply.dataset.error = 'login_required'; return;
      }
      if (res.status === 429) {
        document.querySelector('[data-testid=quota-banner]').hidden = false;
        reply.dataset.state = 'error'; reply.dataset.error = 'quota_exhausted'; return;
      }
      if (!res.ok) { reply.dataset.state = 'error'; reply.dataset.error = 'provider_error'; return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.textContent += dec.decode(value, { stream: true });
      }
      reply.dataset.state = 'done';
    } catch (e) {
      reply.dataset.state = 'stopped';
    } finally {
      controller = null; sendBtn.disabled = false; stopBtn.disabled = true;
    }
  };
</script>
</body></html>`;
