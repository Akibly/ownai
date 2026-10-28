import { BridgeError, PERMISSION_LABELS, permissionAllowsTraffic, type ConnectionRecord } from "@ownai/contracts";

/**
 * Guardrails for route A (a consumer chat website driven through the user's own
 * signed-in browser session).
 *
 * Two separate questions, deliberately not merged:
 *  - May this connector serve *other people's* traffic? Only with written provider
 *    permission. That gate is unchanged and nothing here opens it.
 *  - May the account's own owner drive their own session, on their own machine,
 *    accepting the terms consequences? That is personal use, and it requires an
 *    explicit per-connection acknowledgement (options.personal_use) that the CLI
 *    records. It is never defaulted on.
 */

export const DEFAULT_MAX_TURNS_PER_DAY = 100;
export const DEFAULT_MIN_INTERVAL_MS = 15_000;

export function assertTrafficAllowed(record: ConnectionRecord): void {
  if (!record.enabled) {
    throw new BridgeError("policy_disabled", `Connection "${record.id}" is disabled.`, {
      connection_id: record.id,
    });
  }
  if (permissionAllowsTraffic(record.permission)) return;

  if (record.kind === "consumer_web" && record.options.personal_use === true) {
    // The owner is using their own account; no provider authorization is implied.
    return;
  }
  throw new BridgeError(
    "policy_disabled",
    `Connection "${record.id}" may not serve traffic: ${record.permission} provider permission.`,
    { connection_id: record.id, provider: record.provider },
  );
}

/** True when a connection drives a consumer website under the personal-use acknowledgement. */
export function isPersonalUseWeb(record: ConnectionRecord): boolean {
  return record.kind === "consumer_web" && record.options.personal_use === true;
}

/**
 * The permission line as it applies to this connection. "cannot serve traffic" is
 * only true while the personal-use acknowledgement is absent; printing it on a row
 * that does serve the owner reads as a refusal and sends them looking for a switch
 * that would only be a false claim about the provider.
 */
export function permissionLabel(record: ConnectionRecord): string {
  if (record.permission === "denied" && isPersonalUseWeb(record)) {
    return "Provider prohibits this use; serves your own turns only";
  }
  return PERMISSION_LABELS[record.permission];
}

/**
 * The non-throwing form of assertTrafficAllowed, same rule. Status surfaces use it so
 * what the console claims a request would get cannot drift from what the router does.
 */
export function servesTraffic(record: ConnectionRecord): boolean {
  return record.enabled && (permissionAllowsTraffic(record.permission) || isPersonalUseWeb(record));
}

/**
 * Conservative pacing for personal-use web connections. A real person does not need
 * sustained machine-gun volume, and low rate is the single biggest reduction in
 * "this looks like abuse" signal. These are local limits, not a way to get around
 * the site's own limits: when the site says no, the adapter reports quota_exhausted.
 */
export class TurnBudget {
  private readonly lastCallAt = new Map<string, number>();

  constructor(
    private readonly turnsToday: (connectionId: string) => number,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  private readonly now: () => number;

  check(record: ConnectionRecord): void {
    if (!isPersonalUseWeb(record)) return;
    const maxTurns = record.options.max_turns_per_day ?? DEFAULT_MAX_TURNS_PER_DAY;
    const minInterval = record.options.min_interval_ms ?? DEFAULT_MIN_INTERVAL_MS;

    const used = this.turnsToday(record.id);
    if (used >= maxTurns) {
      throw new BridgeError(
        "rate_limited",
        `Local daily limit reached for "${record.id}" (${maxTurns} turns). Raise it only if you genuinely need more.`,
        { connection_id: record.id, retry_after_s: secondsUntilTomorrow(this.now()) },
      );
    }

    const last = this.lastCallAt.get(record.id);
    if (last !== undefined) {
      const elapsed = this.now() - last;
      if (elapsed < minInterval) {
        throw new BridgeError("rate_limited", `Slow down: "${record.id}" allows one turn per ${Math.ceil(minInterval / 1000)} s.`, {
          connection_id: record.id,
          retry_after_s: Math.ceil((minInterval - elapsed) / 1000),
        });
      }
    }
  }

  /** Called when the turn is actually dispatched, not when it succeeds. */
  mark(record: ConnectionRecord): void {
    if (isPersonalUseWeb(record)) this.lastCallAt.set(record.id, this.now());
  }

  /** Forget pacing after a refusal, so a rejected request does not push the next one back. */
  unmark(record: ConnectionRecord): void {
    if (isPersonalUseWeb(record)) this.lastCallAt.delete(record.id);
  }
}

function secondsUntilTomorrow(nowMs: number): number {
  const next = new Date(nowMs);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, Math.round((next.getTime() - nowMs) / 1000));
}

/** The local-midnight boundary the daily turn count is measured from. */
export function startOfLocalDay(nowMs: number): string {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
