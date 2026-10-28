import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const ModelRef = z.string().regex(/^[a-z0-9][a-z0-9-]*\/.+$/, 'Expected "<connection>/<model>"');

export const RoutingPolicySchema = z.object({
  /** Friendly names that map to a primary target and optional pre-approved fallbacks. */
  aliases: z.record(
    z.string().min(1).max(100),
    z.object({
      primary: ModelRef,
      /**
       * Each fallback is a separate data recipient; consent is recorded per destination
       * (volume 03 §6). Only these, in order, may serve a request the primary cannot.
       */
      fallbacks: z.array(z.object({ target: ModelRef, consented_at: z.iso.datetime() })).default([]),
    }),
  ),
  /** Paid routes are never selected unless this is true (D-04 default: false). */
  allow_paid: z.boolean().default(false),
});

export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

const DEFAULT_POLICY: RoutingPolicy = { aliases: {}, allow_paid: false };

export class PolicyStore {
  constructor(private readonly db: DatabaseSync) {}

  get(): RoutingPolicy {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = 'routing_policy'").get() as
      | { value_json: string }
      | undefined;
    return row ? RoutingPolicySchema.parse(JSON.parse(row.value_json)) : structuredClone(DEFAULT_POLICY);
  }

  set(policy: RoutingPolicy): void {
    const valid = RoutingPolicySchema.parse(policy);
    this.db
      .prepare(
        "INSERT INTO settings (key, value_json) VALUES ('routing_policy', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(JSON.stringify(valid));
  }
}
