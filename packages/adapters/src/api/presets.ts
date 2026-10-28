import type { AdapterCapabilities, ConnectionKind, ConnectionType, Consumption } from "@ownai/contracts";

/**
 * Route C presets: a provider's own documented OpenAI-compatible endpoint, called with
 * a key the owner obtained from that provider.
 *
 * Every field here is a claim about somebody else's service, so capabilities come from
 * the provider's own documentation (checked 28 Oct 2026) rather than from what the OpenAI
 * protocol permits. Anything unverified stays undeclared, which means the bridge refuses
 * it instead of approximating it (TRUTH-3).
 */

export interface ApiPreset {
  type: ConnectionType;
  /** Name shown to the owner on every response. */
  provider: string;
  /** Root that `/chat/completions` and `/models` hang off. Empty when the owner must supply it. */
  baseUrl: string;
  /** The variable the provider's own docs recommend, so a key never has to be typed into a shell. */
  keyEnv: string;
  /** What one reply costs, shown on every response. Absent means the owner must state it. */
  consumption?: Consumption;
  /** A model the provider lists today. The owner can name any other with --model. */
  defaultModel: string;
  /** False only for a server on this machine that asks for no credential. */
  requiresApiKey?: boolean;
  /** False when the provider documents no `/models` route, so a 404 there is not a failure. */
  modelsList?: boolean;
  /** Headers the provider requires. Never a user agent, never a fingerprint. */
  headers?: Record<string, string>;
  capabilities: AdapterCapabilities;
  /** What this route costs, in the owner's terms. */
  note: string;
}

const CAPS = (over: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  text_input: true,
  text_output: true,
  // Documented for every provider below, on the compatible path.
  system_role: "native",
  multi_turn: "native",
  streaming: "native",
  tools: "native",
  // This adapter forwards text parts only, so image parts are refused rather than dropped.
  vision: false,
  // Not separately verified per provider, so a client asking for it is refused.
  json_mode: false,
  sampling_params: ["max_tokens", "max_completion_tokens", "temperature", "top_p", "stop"],
  context_window: null,
  ...over,
});

export const API_PRESETS: Partial<Record<ConnectionType, ApiPreset>> = {
  "free_api:openai": {
    type: "free_api:openai",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    consumption: "paid_credits",
    defaultModel: "gpt-5.6-luna",
    capabilities: CAPS(),
    note: "Pay-as-you-go: every reply draws on the balance you bought.",
  },
  "free_api:xai": {
    type: "free_api:xai",
    provider: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    consumption: "paid_credits",
    defaultModel: "grok-4.7",
    modelsList: false,
    capabilities: CAPS(),
    note: "The xAI API uses separate billing/credits from the free Grok website account.",
  },
  "free_api:deepseek": {
    type: "free_api:deepseek",
    provider: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    consumption: "paid_credits",
    defaultModel: "deepseek-flash",
    modelsList: false,
    capabilities: CAPS(),
    note: "Docs show the bare host with no /v1 suffix, and list no model endpoint.",
  },
  "free_api:qwen": {
    type: "free_api:qwen",
    provider: "Alibaba Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY",
    consumption: "free_quota",
    defaultModel: "qwen-plus",
    modelsList: false,
    capabilities: CAPS(),
    note: "Free quota is for eligible China (Beijing) accounts/models, may expire after 90 days, and can fall back to paid usage. Enable Free Quota Only in Alibaba Model Studio to stop at the limit. Use --base-url for another region.",
  },
  "free_api:groq": {
    type: "free_api:groq",
    provider: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    consumption: "free_quota",
    defaultModel: "llama-3.1-8b-instant",
    capabilities: CAPS({ context_window: 128_000 }),
    note: "Free tier with per-day limits; the provider reports them, we only pass them on.",
  },
  "free_api:gemini": {
    type: "free_api:gemini",
    provider: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    consumption: "free_quota",
    defaultModel: "gemini-3.8-flash",
    capabilities: CAPS(),
    note: "Google documents this compatibility layer as beta.",
  },
  "free_api:openrouter": {
    type: "free_api:openrouter",
    provider: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    consumption: "free_quota",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    capabilities: CAPS(),
    note: "One key, many models. Model IDs come from its own /models list, not from this preset.",
  },
  "free_api:mistral": {
    type: "free_api:mistral",
    provider: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    consumption: "free_quota",
    defaultModel: "mistral-small-latest",
    capabilities: CAPS(),
    note: "Mistral matches the request schema but does not call its API OpenAI-compatible.",
  },
  "free_api:nvidia": {
    type: "free_api:nvidia",
    provider: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    consumption: "free_quota",
    defaultModel: "meta/llama-3.1-8b-instruct",
    capabilities: CAPS(),
    note: "Free credits are metered by NVIDIA; a 429 here means the credit is spent.",
  },
  "local_model:ollama": {
    type: "local_model:ollama",
    provider: "Ollama (this machine)",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyEnv: "OLLAMA_API_KEY",
    consumption: "local_compute",
    defaultModel: "gpt-oss:20b",
    // The local server accepts any bearer value and ignores it, so nothing is stored.
    requiresApiKey: false,
    capabilities: CAPS(),
    note: "Runs on your own hardware. Needs Ollama serving on port 11434.",
  },
  "free_api:custom": {
    type: "free_api:custom",
    provider: "Custom endpoint",
    // Deliberately empty: the owner names the host, so nothing is assumed about it.
    baseUrl: "",
    keyEnv: "OWNAI_API_KEY",
    // No consumption: what an unnamed host costs is something only the owner can say,
    // so `add-api custom` requires --consumption rather than defaulting it.
    defaultModel: "default",
    modelsList: false,
    capabilities: CAPS({
      // A host we have not read the docs for gets the narrowest honest claim.
      streaming: "buffered",
      tools: "none",
      sampling_params: ["max_tokens", "temperature"],
    }),
    note: "Any OpenAI-style server. Capabilities start minimal: raise them only once proven.",
  },
};

/** Route a connection type belongs to, derived from its prefix rather than repeated per preset. */
export function presetKind(type: string): ConnectionKind {
  return type.startsWith("local_model:") ? "local_model" : "free_api";
}
