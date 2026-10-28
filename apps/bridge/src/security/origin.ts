import { BridgeError } from "@ownai/contracts";

/**
 * ADR-012: the bridge listens on loopback only, but any process on the machine can
 * reach it, and a web page can try to via DNS rebinding or a cross-site POST. These
 * two checks defeat both, because the browser's own Host and Origin headers are
 * attacker-controlled by neither.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function assertLoopbackHost(host: string | undefined, port: number): void {
  if (!host) throw new BridgeError("forbidden_origin", "Requests must carry a Host header.");
  const separator = host.lastIndexOf(":");
  // A bare IPv6 host has colons in the address itself, so only treat the last
  // segment as a port when it is digits.
  const maybePort = separator > 0 && /^\d+$/.test(host.slice(separator + 1)) ? host.slice(separator + 1) : undefined;
  const hostname = maybePort === undefined ? host : host.slice(0, separator);

  if (!LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new BridgeError("forbidden_origin", `Host "${hostname}" is not a loopback name.`);
  }
  // port 0 means the OS picked one (tests), so there is nothing fixed to match against.
  if (port !== 0 && maybePort !== undefined && Number(maybePort) !== port) {
    throw new BridgeError("forbidden_origin", "Host port does not match the bridge port.");
  }
}

/**
 * The Origin value this bridge itself is reached at, from the Host header. Loopback is
 * always http, and a same-origin browser request sends exactly this string.
 */
export function selfOrigin(host: string | undefined): string | undefined {
  return host ? `http://${host}` : undefined;
}

/**
 * Browsers always send Origin on POST, so a foreign Origin means a web page is talking
 * to the bridge — the CSRF and DNS-rebinding case these guards exist to stop.
 *
 * A same-origin request (the console acting on itself) carries this bridge's own Origin
 * and is not cross-site, so it is allowed; a rogue page can set neither the Origin nor
 * the gateway key. The allowlist is for an explicitly trusted local web shell.
 */
export function assertAllowedOrigin(
  origin: string | undefined,
  allowlist: readonly string[],
  sameOrigin?: string,
): void {
  if (origin === undefined) return;
  if (sameOrigin !== undefined && origin === sameOrigin) return;
  if (!allowlist.includes(origin)) {
    throw new BridgeError("forbidden_origin", `Origin "${origin}" is not allowed to reach the bridge.`);
  }
}
