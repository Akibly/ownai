/**
 * Capability model. Adapters declare only what a repeatable test has verified;
 * anything not declared is rejected rather than simulated.
 */

/** Which access route a connection uses (A / B / C, plus the test-only mock). */
export type ConnectionKind = "consumer_web" | "account_grant" | "free_api" | "local_model" | "mock";

export const CONNECTION_KIND_ROUTE: Record<ConnectionKind, "A" | "B" | "C" | "test"> = {
  consumer_web: "A",
  account_grant: "B",
  free_api: "C",
  local_model: "C",
  mock: "test",
};

/** What a request consumes. Displayed to users on every response and activity row. */
export type Consumption = "plan_allowance" | "free_quota" | "local_compute" | "paid_credits" | "none";

export type ModelConfidence = "verified" | "provider_declared" | "unknown";

/** native = provider emits incremental output; buffered = one final chunk; none = stream:true rejected. */
export type StreamingSupport = "native" | "buffered" | "none";

export interface AdapterCapabilities {
  text_input: boolean;
  text_output: boolean;
  /** native = provider honours a system role; emulated = folded into the prompt text; none = rejected. */
  system_role: "native" | "emulated" | "none";
  /** native = provider receives structured turns; flattened = turns are serialized into one prompt. */
  multi_turn: "native" | "flattened";
  streaming: StreamingSupport;
  tools: boolean;
  vision: boolean;
  json_mode: boolean;
  /** Request parameters the provider actually honours, e.g. ["max_tokens", "temperature"]. */
  sampling_params: readonly string[];
  /** Null when the provider does not publish it. Never guessed. */
  context_window: number | null;
}

/** Whether a provider has authorized this connector for the way we use it. */
export type PermissionStatus =
  /** No third-party permission needed (local models, mock, documented public API terms). */
  | "not_required"
  /** Written authorization on record (see permission_ref). */
  | "approved"
  /** Requested or under review: the connection cannot serve traffic. */
  | "pending"
  /** Provider declined, or terms prohibit this use: the connection cannot serve traffic. */
  | "denied";

export function permissionAllowsTraffic(status: PermissionStatus): boolean {
  return status === "not_required" || status === "approved";
}
