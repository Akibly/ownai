const REDACTED = "[REDACTED]";

// Shapes of credentials that must never leave the bridge in an error, log or export.
const PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk|gsk|sk-or|byoai_local)[-_][A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:access|refresh|id)_token["'=:\s]+[A-Za-z0-9._~+/-]{8,}/gi,
  /\bcookie["'=:\s]+[^\s;]{8,}/gi,
];

/**
 * Removes known secret values and credential-shaped strings from text.
 * Applied to every error message before it reaches a client, log or diagnostic export.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  addSecret(value: string | null | undefined): void {
    if (value && value.length >= 6) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(REDACTED);
    for (const p of PATTERNS) out = out.replace(p, REDACTED);
    return out;
  }
}
