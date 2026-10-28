import { BridgeError } from "@ownai/contracts";
import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "./api-keys.ts";

const UNAUTHENTICATED_ROUTES = new Set(["GET /health"]);

/**
 * Loopback request guards (ADR-012), in order:
 *  1. Host allowlist: defeats DNS rebinding, where a hostile domain resolves to 127.0.0.1.
 *  2. Origin / Sec-Fetch-Site: a web page in the user's browser cannot call the bridge
 *     unless its origin was explicitly allowed. Non-browser clients send no Origin.
 *  3. Gateway key on every route except GET /health, even on loopback.
 */
export function registerGuards(
  app: FastifyInstance,
  opts: { port: number; allowedOrigins: string[]; apiKeys: ApiKeyStore },
): void {
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  const allowedOrigins = new Set(opts.allowedOrigins);

  app.addHook("onRequest", async (req) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) {
      throw new BridgeError("forbidden_origin", "Requests must be addressed to the loopback host.");
    }

    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      throw new BridgeError("forbidden_origin", "Browser origin is not allowed to call OwnAI.");
    }
    if (origin === undefined && fetchSite !== undefined && fetchSite !== "none" && fetchSite !== "same-origin") {
      throw new BridgeError("forbidden_origin", "Cross-site browser requests are not allowed.");
    }

    const route = `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`;
    if (UNAUTHENTICATED_ROUTES.has(route)) return;

    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1] || !opts.apiKeys.verify(match[1])) {
      throw new BridgeError("invalid_api_key", "Missing or invalid local API key.");
    }
  });
}
