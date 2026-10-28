import type { ConnectionRecord } from "@ownai/contracts";
import { providerKeyRef } from "./secrets.ts";

/** Preset connection records. Everything is explicit; nothing is defaulted on silently. */

const now = () => new Date().toISOString();

function base(over: Partial<ConnectionRecord>): ConnectionRecord {
  const ts = now();
  return {
    id: over.id!,
    type: over.type!,
    provider: over.provider!,
    kind: over.kind!,
    consumption: over.consumption!,
    model: over.model ?? "default",
    alias: over.alias ?? over.id!,
    enabled: over.enabled ?? true,
    permission: over.permission ?? "not_required",
    secret_ref: over.secret_ref ?? null,
    fallback_ids: over.fallback_ids ?? [],
    options: over.options ?? {},
    created_at: ts,
    updated_at: ts,
  };
}

export function mockConnection(id = "mock"): ConnectionRecord {
  return base({
    id,
    alias: id,
    type: "mock",
    provider: "Mock provider",
    kind: "mock",
    consumption: "none",
    model: "mock-echo",
    permission: "not_required",
  });
}

export function mockChatConnection(baseUrl: string, id = "mock-chat"): ConnectionRecord {
  return base({
    id,
    alias: id,
    type: "browser:mock-chat",
    provider: "Mock Chat (test site)",
    kind: "consumer_web",
    consumption: "none",
    permission: "approved",
    options: { base_url: baseUrl, mode: "background" },
  });
}

export interface ClaudeConnectionInput {
  id?: string;
  alias?: string;
  mode?: "visible" | "background" | "automatic";
  /** What the owner says the account is. The page is not asked and does not confirm it. */
  plan?: "free" | "pro" | "max";
  /** Must be explicitly true; without it the router refuses this connection. */
  personalUse: boolean;
  /**
   * Ask the page to follow a text protocol in place of a tool interface, so clients that
   * need tools can use this connection. Off unless the owner says so: every step costs a
   * turn of the account's own allowance.
   */
  promptTools?: boolean;
  maxTurnsPerDay?: number;
  minIntervalMs?: number;
  channel?: string;
}

export interface AccountWebConnectionInput {
  provider: "chatgpt" | "grok" | "qwen" | "deepseek";
  id?: string;
  alias?: string;
  mode?: "visible" | "background" | "automatic";
  personalUse: boolean;
  promptTools?: boolean;
  maxTurnsPerDay?: number;
  minIntervalMs?: number;
}

/** Personal consumer-account route. The site account owner signs in manually. */
export function accountWebConnection(input: AccountWebConnectionInput): ConnectionRecord {
  if (!input.personalUse) {
    throw new Error("accountWebConnection requires the account owner's personal-use acknowledgement.");
  }
  const id = input.id ?? `${input.provider}-web`;
  const names: Record<AccountWebConnectionInput["provider"], string> = {
    chatgpt: "ChatGPT",
    grok: "Grok",
    qwen: "Qwen",
    deepseek: "DeepSeek",
  };
  const name = names[input.provider];
  return base({
    id,
    alias: input.alias ?? input.provider,
    type: `browser:${input.provider}` as ConnectionRecord["type"],
    provider: `${name} (your browser session)`,
    kind: "consumer_web",
    consumption: "free_quota",
    model: "default",
    permission: "denied",
    options: {
      mode: input.mode ?? "automatic",
      personal_use: true,
      plan_declared_by_owner: "free",
      max_turns_per_day: input.maxTurnsPerDay ?? 100,
      min_interval_ms: input.minIntervalMs ?? 15_000,
      ...(input.promptTools ? { prompt_tools: true } : {}),
    },
  });
}

export function claudeConnection(input: ClaudeConnectionInput): ConnectionRecord {
  const id = input.id ?? "claude-web";
  if (!input.personalUse) {
    throw new Error(
      "claudeConnection requires personalUse: true. Serving other people's traffic through claude.ai needs written provider permission.",
    );
  }
  return base({
    id,
    alias: input.alias ?? "claude",
    type: "browser:claude",
    provider: "Claude (your own browser session)",
    kind: "consumer_web",
    // Declared by the account owner, because the page never states which plan it is on.
    consumption: input.plan === "free" ? "free_quota" : "plan_allowance",
    model: "default",
    // The provider has not authorized this use; personal use is the narrower basis.
    permission: "denied",
    options: {
      mode: input.mode ?? "automatic",
      personal_use: true,
      plan_declared_by_owner: input.plan ?? "free",
      max_turns_per_day: input.maxTurnsPerDay ?? 100,
      min_interval_ms: input.minIntervalMs ?? 15_000,
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.promptTools ? { prompt_tools: true } : {}),
    },
  });
}

/** Explicit test helper. Fresh production runtimes do not create a mock connection. */
export function defaultConnection(): ConnectionRecord {
  return mockConnection();
}

export interface ApiConnectionInput {
  type: ConnectionRecord["type"];
  provider: string;
  kind: ConnectionRecord["kind"];
  consumption: ConnectionRecord["consumption"];
  model: string;
  id: string;
  alias?: string;
  baseUrl?: string;
  /** Explicit, owner-verified capabilities for a custom OpenAI-compatible host. */
  capabilities?: {
    tools?: boolean;
    streaming?: "buffered" | "native";
    json_mode?: boolean;
    sampling_params?: string[];
  };
}

/**
 * Route C: the provider issued this key for programmatic use, so no third-party
 * permission is being stretched. The key itself never appears here — only its vault
 * reference (ADR-010).
 */
export function apiConnection(input: ApiConnectionInput): ConnectionRecord {
  return base({
    id: input.id,
    alias: input.alias ?? input.id,
    type: input.type,
    provider: input.provider,
    kind: input.kind,
    consumption: input.consumption,
    model: input.model,
    permission: "not_required",
    secret_ref: providerKeyRef(input.id),
    options: {
      ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    },
  });
}
