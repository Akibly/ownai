import type {
  AdapterCapabilities,
  ConnectionKind,
  Consumption,
  FinishReason,
  ModelConfidence,
  QuotaStatus,
  ToolCall,
  Usage,
} from "@ownai/contracts";

export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Null when the turn exists only to carry tool calls or a tool result. */
  content: string | null;
  /** Only present on an assistant turn from a connection that declares tools. */
  tool_calls?: ToolCall[];
  /** Only on a tool turn: which call this result answers. */
  tool_call_id?: string;
  /** Only on a tool turn: the function name the provider must match. */
  name?: string;
}

export interface AdapterRequest {
  /** Provider-side model ID (the part after "<connection>/"). */
  model: string;
  messages: NormalizedMessage[];
  /** Only parameters listed in the adapter's sampling_params ever reach it. */
  params: Record<string, unknown>;
  /** Client-supplied tool definitions, forwarded verbatim when the adapter declares tools. */
  tools?: unknown[];
  tool_choice?: unknown;
  /** Reaches the provider only when the adapter declares json_mode. */
  response_format?: unknown;
}

/**
 * Output as it arrives. Text streams in fragments; a tool call arrives whole, because
 * a half-parsed argument string is not callable and clients are not asked to stitch one.
 */
export interface OutputDelta {
  text?: string;
  tool_calls?: ToolCall[];
}

export interface GenerateContext {
  signal: AbortSignal;
  /** Called per delta only when the adapter streams natively. */
  onDelta?: (delta: OutputDelta) => void;
}

export interface AdapterResult {
  text: string;
  finish_reason: FinishReason;
  /** Tool calls the model asked for, in the shape the client described them. */
  tool_calls?: ToolCall[];
  /** Model the provider reports having used, or the requested ID when the provider does not say. */
  model: string;
  model_confidence: ModelConfidence;
  usage?: Usage;
  quota_status?: QuotaStatus;
}

export interface AdapterModel {
  id: string;
  confidence: ModelConfidence;
}

export type HealthState = "ready" | "needs_login" | "quota_exhausted" | "provider_unavailable" | "degraded";

export interface AdapterHealth {
  state: HealthState;
  detail?: string;
}

/**
 * Contract every provider route implements. Core routing never depends on
 * provider-specific behaviour beyond what is expressed here.
 *
 * Errors MUST be thrown as BridgeError. Set details.generation_started once the
 * prompt may have reached the provider, so the router never re-sends it elsewhere.
 */
export interface ProviderAdapter {
  /** Adapter type, e.g. "mock", "browser:mock-chat", "ollama". */
  readonly type: string;
  /** Human-readable provider name shown in responses and the UI. */
  readonly provider: string;
  readonly kind: ConnectionKind;
  readonly consumption: Consumption;
  capabilities(): AdapterCapabilities;
  listModels(signal?: AbortSignal): Promise<AdapterModel[]>;
  health(signal?: AbortSignal): Promise<AdapterHealth>;
  /**
   * Consult the provider instead of answering from local state, read-only. A browser
   * route has no way to know whether it is signed in until it opens the page, so
   * health() says "ready" for one that has never been started; probe() opens it and
   * reports what is there. It never submits a prompt and never spends a turn.
   */
  probe?(signal?: AbortSignal): Promise<AdapterHealth>;
  generate(request: AdapterRequest, ctx: GenerateContext): Promise<AdapterResult>;
  close(): Promise<void>;
}
