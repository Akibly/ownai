import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Gateway keys: the bearer token a client must present to reach the bridge, even on
 * loopback (FR-03). A new one is generated per device, shown once, and only its
 * SHA-256 digest is compared at request time (ADR-011).
 */

/**
 * The prefix is a label, not an input to authentication. Requests are matched by the
 * SHA-256 digest of the whole string, so keys minted under the pre-rename prefix keep
 * working after the label changes and stay accepted until their row is removed.
 */
export const KEY_PREFIX = "sk-ownai-";
export const LEGACY_KEY_PREFIXES: readonly string[] = ["sk-local-"];

export function newGatewayKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashGatewayKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Constant-time comparison of digests, so a wrong key costs the same as a near-miss. */
export function gatewayKeyMatches(candidate: string, storedHash: string): boolean {
  const candidateHash = hashGatewayKey(candidate);
  if (candidateHash.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(candidateHash, "latin1"), Buffer.from(storedHash, "latin1"));
}

export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  const token = rest.join(" ");
  return token.length > 0 ? token : undefined;
}
