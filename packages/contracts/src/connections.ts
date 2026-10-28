import type { Consumption, ConnectionKind, PermissionStatus } from "./capabilities.ts";

/**
 * A connection is one concrete way to reach one provider account, recorded on the
 * user's device only (ADR-001). A model alias always resolves to exactly one of
 * these, never to "whichever looks best" (ADR-005).
 */

export type ConnectionType =
  | "mock"
  | "browser:mock-chat"
  | "browser:claude"
  | "browser:chatgpt"
  | "browser:grok"
  | "browser:qwen"
  | "browser:deepseek"
  | "free_api:openai"
  | "free_api:xai"
  | "free_api:deepseek"
  | "free_api:qwen"
  | "free_api:mistral"
  | "free_api:nvidia"
  | "free_api:gemini"
  | "free_api:groq"
  | "free_api:openrouter"
  | "free_api:custom"
  | "local_model:ollama";

/** Where the browser engine runs a consumer-web connection. Mirrors ADR-015. */
export type BrowserModeSetting = "visible" | "background" | "automatic";

export interface ConnectionRecord {
  id: string;
  type: ConnectionType;
  /** Provider name shown to the user on every response. */
  provider: string;
  kind: ConnectionKind;
  consumption: Consumption;
  /** Provider-side model ID, or "default" when the site chooses it. */
  model: string;
  /** Public alias clients use; defaults to id. */
  alias: string;
  enabled: boolean;
  permission: PermissionStatus;
  /** Reference to the provider secret in the OS keychain. Never the secret itself. */
  secret_ref: string | null;
  /** Only connections the user explicitly listed may serve a request if the first fails. */
  fallback_ids: string[];
  options: ConnectionOptions;
  created_at: string;
  updated_at: string;
}

export type ConnectionOptions = {
  mode?: BrowserModeSetting;
  /** Isolated per-connection browser profile directory. Never shared. */
  profile_dir?: string;
  /** "msedge" to drive the installed Edge instead of bundled Chromium. */
  channel?: string;
  /** Installed browser executable, used when a browser has no Playwright channel. */
  executable_path?: string;
  /** User-authorized attachment to Brave's default profile through its local DevTools port. */
  brave_attach?: boolean;
  base_url?: string;
  /** Public route-A guardrails; see apps/bridge/src/policy.ts. */
  max_turns_per_day?: number;
  min_interval_ms?: number;
  /**
   * Explicit acknowledgement that the account owner is driving their own session on
   * their own machine and accepts the terms consequences. Never defaulted to true,
   * and it authorizes nothing beyond that single user's own use.
   */
  personal_use?: boolean;
  [key: string]: unknown;
};

export const PERMISSION_LABELS: Record<PermissionStatus, string> = {
  not_required: "No third-party permission needed",
  approved: "Written provider permission on record",
  pending: "Permission requested; cannot serve traffic",
  denied: "Provider prohibits this use; cannot serve traffic",
};
