import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  BridgeError,
  ChatCompletionRequestSchema,
  SCHEMA_VERSION,
  isBridgeError,
  toErrorBody,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
} from "@ownai/contracts";
import { assertAllowedOrigin, assertLoopbackHost, selfOrigin } from "./security/origin.ts";
import { extractBearer, gatewayKeyMatches, hashGatewayKey } from "./auth.ts";
import type { BridgeStore } from "./stores/store.ts";
import type { AdapterRegistry } from "./registry.ts";
import { Router } from "./router.ts";
import { selectorGroupsForType, SELECTOR_GROUPS } from "@ownai/adapters";
import { Redactor } from "./redact.ts";
import { CONSOLE_CSS, CONSOLE_JS, maskKey, renderConsole } from "./console.ts";
import { ConcurrencyGate } from "./concurrency.ts";

/**
 * The local HTTP facade: OpenAI-compatible shape over loopback transport. Nothing
 * here is reachable from another machine, and no generation route is reachable
 * without a gateway key (FR-03, ADR-012).
 */

export const BRIDGE_VERSION = "0.1.0";

export interface StartBridgeOptions {
  store: BridgeStore;
  registry: AdapterRegistry;
  router?: Router;
  port: number;
  /** Origins a local desktop shell may send. Empty means no browser client at all. */
  originAllowlist?: string[];
  /** Values that must never surface in an error message or log line. */
  secrets?: string[];
  /**
   * Reads the gateway key out of the OS credential store, wired by the CLI because
   * only the runtime holds a SecretStore. The console prints a masked preview derived
   * from it and fetches the full value only when Reveal is clicked; the plaintext is
   * never written into the page source.
   */
  revealGatewayKey?: () => Promise<string | null>;
  /** Adds one documented built-in API connection and stores its provider key in the OS vault. */
  addApiConnection?: (input: {
    provider: string;
    model: string;
    alias: string;
    apiKey?: string;
  }) => Promise<{ id: string; alias: string; provider: string; model: string }>;
  /** Reads model IDs from a provider API using a transient key; it must not persist that key. */
  listApiModels?: (input: { provider: string; apiKey?: string }) => Promise<string[]>;
  maxConcurrent?: number;
  maxQueued?: number;
  bodyLimitBytes?: number;
}

export interface RunningBridge {
  url: string;
  port: number;
  router: Router;
  app: FastifyInstance;
  close(): Promise<void>;
}

/** Built separately so tests can drive it with inject() and never bind a port. */
export function buildApp(options: StartBridgeOptions): { app: FastifyInstance; router: Router } {
  const { store, registry } = options;
  const allowlist = options.originAllowlist ?? [];
  const redactor = new Redactor(options.secrets ?? []);
  const router = options.router ?? new Router({ store, registry });
  const limiter = new ConcurrencyGate(options.maxConcurrent ?? 4, options.maxQueued ?? 16);

  const app = Fastify({ logger: false, bodyLimit: options.bodyLimitBytes ?? 1_048_576 });

  // The console is metadata-only and offers no action, so it shares /health's trust
  // level rather than the generation gate. Host and Origin guards still apply, which
  // is what actually stops a remote page from reading it.
  const publicPaths = new Set(["/health", "/", "/console", "/console.css", "/console.js", "/console/key"]);

  app.addHook("onRequest", async (req) => {
    assertLoopbackHost(req.headers.host, options.port);
    assertAllowedOrigin(req.headers.origin, allowlist, selfOrigin(req.headers.host));
  });

  app.addHook("onRequest", async (req, reply) => {
    const requestId = randomUUID();
    reply.header("x-request-id", requestId);
    const path = req.url.split("?")[0] ?? req.url;
    if (publicPaths.has(path)) return;
    authorize(store, req.headers.authorization);
  });

  app.get("/health", async () => ({
    status: "ok",
    version: BRIDGE_VERSION,
    schema_version: SCHEMA_VERSION,
    transport: "loopback-only",
  }));

  app.get("/", async (_req, reply) => reply.code(302).header("location", "/console").send());

  app.get("/console.css", async (_req, reply) => {
    reply.header("content-type", "text/css; charset=utf-8").header("x-content-type-options", "nosniff");
    return CONSOLE_CSS;
  });

  app.get("/console.js", async (_req, reply) => {
    reply.header("content-type", "text/javascript; charset=utf-8").header("x-content-type-options", "nosniff");
    return CONSOLE_JS;
  });

  // Deliberately outside the generation gate but inside the Host and Origin guards:
  // it is the same privileged read the CLI performs, and only ever answers loopback.
  app.get("/console/key", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.revealGatewayKey) {
      return reply.code(503).send({ error: { code: "no_credential_store", message: "No credential store is wired into this server." } });
    }
    const key = await options.revealGatewayKey();
    if (!key) return reply.code(404).send({ error: { code: "no_key", message: "No gateway key exists yet." } });
    return { key };
  });

  app.post("/console/providers", async (req, reply) => {
    if (!options.addApiConnection) {
      return reply.code(503).send({ error: { code: "provider_setup_unavailable", message: "Provider setup is unavailable in this server." } });
    }
    const body = req.body as { provider?: unknown; model?: unknown; alias?: unknown; api_key?: unknown } | undefined;
    if (!body || typeof body.provider !== "string" || typeof body.model !== "string" || typeof body.alias !== "string") {
      throw new BridgeError("invalid_request", "Choose a provider, model, and alias.");
    }
    const provider = body.provider.trim().toLowerCase();
    const model = body.model.trim();
    const alias = body.alias.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(provider)) {
      throw new BridgeError("invalid_request", "Choose a supported provider.", { param: "provider" });
    }
    if (!model || model.length > 200) {
      throw new BridgeError("invalid_request", "Model must be between 1 and 200 characters.", { param: "model" });
    }
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(alias)) {
      throw new BridgeError("invalid_request", "Alias must use lowercase letters, numbers, and hyphens (up to 40 characters).", { param: "alias" });
    }
    if (body.api_key !== undefined && typeof body.api_key !== "string") {
      throw new BridgeError("invalid_request", "API key must be text.", { param: "api_key" });
    }
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : undefined;
    if (apiKey && apiKey.length > 2048) {
      throw new BridgeError("invalid_request", "API key is too long.", { param: "api_key" });
    }
    const connection = await options.addApiConnection({ provider, model, alias, ...(apiKey ? { apiKey } : {}) });
    reply.code(201).header("cache-control", "no-store");
    return { connection };
  });

  app.post("/console/providers/:provider/models", async (req, reply) => {
    if (!options.listApiModels) {
      return reply.code(503).send({ error: { code: "provider_setup_unavailable", message: "Model discovery is unavailable in this server." } });
    }
    const params = req.params as { provider?: string };
    const body = req.body as { api_key?: unknown } | undefined;
    if (!params.provider || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(params.provider)) {
      throw new BridgeError("invalid_request", "Choose a supported provider.", { param: "provider" });
    }
    if (body?.api_key !== undefined && typeof body.api_key !== "string") {
      throw new BridgeError("invalid_request", "API key must be text.", { param: "api_key" });
    }
    const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : undefined;
    if (apiKey && apiKey.length > 2048) {
      throw new BridgeError("invalid_request", "API key is too long.", { param: "api_key" });
    }
    const models = await options.listApiModels({ provider: params.provider, ...(apiKey ? { apiKey } : {}) });
    reply.header("cache-control", "no-store");
    return { models };
  });

  app.get("/console", async (req, reply) => {
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; " +
          "font-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    // Masked here, so the page a viewer or screenshot tool loads never holds the secret.
    const preview = options.revealGatewayKey ? maskKey(await options.revealGatewayKey()) : null;
    return renderConsole({
      store,
      host: req.headers.host ?? `127.0.0.1:${options.port}`,
      version: BRIDGE_VERSION,
      keyPreview: preview,
      keyRevealable: Boolean(options.revealGatewayKey),
      providerSetupEnabled: Boolean(options.addApiConnection),
    });
  });

  app.get("/v1/models", async () => ({ object: "list", data: await router.listModels() }));

  // Console state change. Not a public path, so the bearer check above already ran:
  // only a caller holding the gateway key — which is readable only from this same
  // origin — can flip a connection. It changes local configuration and nothing else:
  // it never instantiates an adapter, launches a browser, spends a turn or calls a provider.
  app.patch("/console/connections/:id", async (req, reply) => {
    const id = (req.params as { id?: string }).id;
    if (!id) throw new BridgeError("invalid_request", "A connection id is required.", { param: "id" });
    const body = req.body as { enabled?: unknown } | undefined;
    if (!body || typeof body.enabled !== "boolean") {
      throw new BridgeError("invalid_request", 'Body must be { "enabled": true | false }.', { param: "enabled" });
    }
    if (!store.getConnection(id)) {
      throw new BridgeError("invalid_request", `No connection "${id}".`, { param: "id", connection_id: id });
    }
    store.setConnectionEnabled(id, body.enabled);
    reply.header("cache-control", "no-store");
    const updated = store.getConnection(id)!;
    return { ok: true, connection: { id: updated.id, alias: updated.alias, enabled: updated.enabled } };
  });

  // Console connection test. Same bearer + same-origin gate as the toggle above. It runs
  // adapter health(), which for every route confirms reachability and sign-in WITHOUT
  // sending a prompt or spending a turn. A browser connection still opens the provider's
  // own site read-only, so it needs an explicit second step: the warning text comes from
  // the server so the two sides cannot drift. This is friction against an accidental
  // click, not the security control — the key and origin checks are that.
  app.post("/console/connections/:id/test", async (req, reply) => {
    const id = (req.params as { id?: string }).id;
    if (!id) throw new BridgeError("invalid_request", "A connection id is required.", { param: "id" });
    const record = store.getConnection(id);
    if (!record) throw new BridgeError("invalid_request", `No connection "${id}".`, { param: "id", connection_id: id });

    const body = (req.body ?? {}) as { confirm?: unknown };
    if (record.kind === "consumer_web" && body.confirm !== true) {
      reply.header("cache-control", "no-store");
      return {
        requires_confirmation: true,
        warning:
          `Checking "${record.alias}" opens a window on the provider's own site to see whether you are signed in, then closes it. ` +
          "It sends no message and uses no turn, but it does touch the live site.",
      };
    }

    reply.header("cache-control", "no-store");
    const health = await limiter.run(() => router.probe(id), cancellationSignal(req, reply));
    return {
      ok: health.state === "ready",
      state: health.state,
      ...(health.detail ? { detail: health.detail } : {}),
    };
  });

  /**
   * Selector tuning from the console. Config only: it opens no browser and spends no
   * turn. The registry fingerprints connection options, so the next request rebuilds
   * the adapter with the new lists — the same thing `bridge selectors` writes.
   */
  app.post("/console/connections/:id/selectors", async (req, reply) => {
    const id = (req.params as { id?: string }).id;
    if (!id) throw new BridgeError("invalid_request", "A connection id is required.", { param: "id" });
    const record = store.getConnection(id);
    if (!record) throw new BridgeError("invalid_request", `No connection "${id}".`, { param: "id", connection_id: id });
    if (!selectorGroupsForType(record.type)) {
      throw new BridgeError("invalid_request", `"${record.alias}" has no page selectors to tune.`, {
        param: "id",
        connection_id: id,
      });
    }
    const body = (req.body ?? {}) as { groups?: unknown };
    if (!body.groups || typeof body.groups !== "object" || Array.isArray(body.groups) || Object.keys(body.groups).length === 0) {
      throw new BridgeError("invalid_request", 'Provide at least one selector group, for example { "groups": { "composer": ["textarea"] } }.', { param: "groups" });
    }
    const overrides = { ...(record.options.selectors as Record<string, string[]> | undefined) };
    for (const [group, value] of Object.entries(body.groups as Record<string, unknown>)) {
      if (!(SELECTOR_GROUPS as readonly string[]).includes(group)) {
        throw new BridgeError("invalid_request", `Unknown selector group "${group}". One of: ${SELECTOR_GROUPS.join(", ")}`, {
          param: "groups",
        });
      }
      if (!Array.isArray(value) || value.length > 8 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)) {
        throw new BridgeError(
          "invalid_request",
          `"${group}" takes up to 8 non-empty selectors of at most 300 characters. Send an empty list to return to the site's defaults.`,
          { param: group },
        );
      }
      const list = (value as string[]).map((item) => item.trim());
      // An empty list means "use the site's defaults", not "match nothing", which is
      // why a blanked group is deleted rather than stored as an empty override.
      if (list.length === 0) delete overrides[group];
      else overrides[group] = list;
    }
    const updated = { ...record, options: { ...record.options, selectors: overrides }, updated_at: new Date().toISOString() };
    store.upsertConnection(updated);
    reply.header("cache-control", "no-store");
    return { ok: true, connection: { id: updated.id, alias: updated.alias }, selectors: overrides };
  });

  app.get("/v1/bridge/capabilities", async (req) => {    const connection = (req.query as { connection?: string }).connection;
    if (!connection) {
      return {
        connections: store.listConnections().map((c) => ({
          id: c.id,
          alias: c.alias,
          provider: c.provider,
          kind: c.kind,
          route: routeOf(c.kind),
          enabled: c.enabled,
          permission: c.permission,
          consumption: c.consumption,
          personal_use: c.options.personal_use === true,
        })),
      };
    }
    const { record, capabilities } = await router.capabilities(connection);
    return {
      connection_id: record.id,
      provider: record.provider,
      kind: record.kind,
      consumption: record.consumption,
      permission: record.permission,
      capabilities,
      note: "Only verified capabilities are listed. Anything absent is refused, never simulated.",
    };
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const requestId = String(reply.getHeader("x-request-id") ?? randomUUID());
    const parsed = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new BridgeError("invalid_request", `Malformed request: ${first?.message ?? "see issues"}.`, {
        param: first ? first.path.join(".") : undefined,
      });
    }
    const request = parsed.data;
    const signal = cancellationSignal(req, reply);

    if (!request.stream) {
      const result = await limiter.run(() => router.complete(request, { requestId, signal }), signal);
      return reply.send(result);
    }
    return streamCompletion(reply, router, request, requestId, signal, limiter, redactor);
  });

  app.setErrorHandler((err, _req, reply) => {
    const requestId = String(reply.getHeader("x-request-id") ?? randomUUID());
    const bridgeError = isBridgeError(err) ? err
      : err instanceof Error && "statusCode" in err && err.statusCode === 400
        ? new BridgeError("invalid_request", "Malformed request body.")
        : new BridgeError("internal_error", "The bridge failed to handle the request.");
    const body = toErrorBody(bridgeError, requestId);
    body.error.message = redactor.redact(body.error.message);
    return reply.status(bridgeError.status).send(body);
  });

  return { app, router };
}

export async function startBridge(options: StartBridgeOptions): Promise<RunningBridge> {
  const { app, router } = buildApp(options);
  await app.listen({ host: "127.0.0.1", port: options.port });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    router,
    app,
    async close() {
      await app.close();
      await options.registry.closeAll();
    },
  };
}

function authorize(store: BridgeStore, authorization: string | undefined): void {
  const key = extractBearer(authorization);
  if (!key) throw new BridgeError("invalid_api_key", "A gateway key is required, even from loopback.");
  const candidateHash = hashGatewayKey(key);
  const stored = store.findKeyByHash(candidateHash);
  // SQLite finds by digest equality; the confirm step keeps the comparison off any
  // guessable prefix (ADR-011).
  if (!stored || !gatewayKeyMatches(key, stored.keyHash)) {
    throw new BridgeError("invalid_api_key", "Gateway key not recognised.");
  }
  store.touchKey(stored.id);
}

async function streamCompletion(
  reply: FastifyReply,
  router: Router,
  request: ChatCompletionRequest,
  requestId: string,
  signal: AbortSignal,
  limiter: ConcurrencyGate,
  redactor: Redactor,
): Promise<FastifyReply> {
  // Take over the response before touching the socket, or Fastify sends a second body.
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "x-request-id": requestId,
  });

  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomUUID()}`;
  let roleSent = false;
  const write = (chunk: ChatCompletionChunk) => reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);

  try {
    const result = await limiter.run(() =>
      router.complete(request, {
        requestId,
        signal,
        onDelta: (delta) => {
          const content = delta.text;
          // Tool calls arrive already stitched: a client cannot execute half an argument string.
          if (content === undefined && delta.tool_calls) {
            write({
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [
                { index: 0, delta: roleSent ? { tool_calls: delta.tool_calls } : { role: "assistant", tool_calls: delta.tool_calls }, finish_reason: null },
              ],
            });
            roleSent = true;
            return;
          }
          write({
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              { index: 0, delta: roleSent ? { content } : { role: "assistant", content }, finish_reason: null },
            ],
          });
          roleSent = true;
        },
      }), signal,
    );
    // A buffered adapter has emitted nothing yet, so its content arrives in the
    // terminal chunk rather than being silently dropped.
    if (!roleSent) {
      write({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: result.choices[0]?.message.content ?? "" },
            finish_reason: null,
          },
        ],
      });
    }
    write({
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [{ index: 0, delta: {}, finish_reason: result.choices[0]?.finish_reason ?? "stop" }],
      ...(result.usage ? { usage: result.usage } : {}),
      bridge: result.bridge,
    });
    reply.raw.write("data: [DONE]\n\n");
  } catch (err) {
    const bridgeError = isBridgeError(err) ? err : new BridgeError("internal_error", "Streaming failed.");
    const body = toErrorBody(bridgeError, requestId);
    body.error.message = redactor.redact(body.error.message);
    reply.raw.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
  } finally {
    reply.raw.end();
  }
  return reply;
}

/** A client that hangs up must stop the provider, not just the HTTP response. */
function cancellationSignal(req: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  req.raw.once("aborted", () => controller.abort());
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

function routeOf(kind: string): string {
  return { consumer_web: "A", account_grant: "B", free_api: "C", local_model: "C", mock: "test" }[kind] ?? "unknown";
}

