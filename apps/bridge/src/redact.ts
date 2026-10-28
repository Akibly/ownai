/**
 * Errors must be useful without being leaky. Adapters already genericize their own
 * messages, but a raw upstream failure can still carry a cookie, a bearer token, a
 * session URL or a fragment of somebody's prompt, so nothing leaves the bridge
 * before this pass (T14).
 */

const SECRET_ASSIGNMENT = /\b(cookie|authorization|set-cookie|token|api[_-]?key|secret)\b\s*[:=]\s*\S+/gi;
const LONG_OPAQUE = /\b[A-Za-z0-9+/_-]{24,}={0,2}\b/g;
const MAX_LENGTH = 400;

export class Redactor {
  private readonly known: string[];

  constructor(secrets: readonly string[] = []) {
    this.known = secrets.filter((s) => s.length >= 8);
  }

  /** Only whole known secrets are substituted, so short values are skipped deliberately. */
  redact(text: string | undefined): string {
    if (!text) return "No further detail available.";
    let out = text.replace(/\s+/g, " ").trim();
    for (const secret of this.known) out = out.split(secret).join("[redacted]");
    out = out.replace(SECRET_ASSIGNMENT, "$1: [redacted]").replace(LONG_OPAQUE, "[redacted]");
    if (out.length > MAX_LENGTH) out = `${out.slice(0, MAX_LENGTH)}…`;
    return out;
  }
}
