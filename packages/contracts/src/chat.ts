import { z } from "zod";
import type { Consumption, ConnectionKind, ModelConfidence, StreamingSupport, ToolSupport } from "./capabilities.ts";

export const SCHEMA_VERSION = "2026-10-26";

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
// Non-text parts are parsed so they can be rejected with unsupported_feature instead of a vague 400.
const OtherPart = z.looseObject({ type: z.string() });
const ContentPart = z.union([TextPart, OtherPart]);

export const ChatMessageSchema = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
  name: z.string().optional(),
  /** Assistant turns from a tool-capable client; kept verbatim so the provider can match them. */
  tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
});

/** One function call the model asked for, in the shape the client sent tools in. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export const ChatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1).max(200),
  messages: z.array(ChatMessageSchema).min(1).max(500),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Fields accepted without effect because they carry no semantics the adapter must honour.
 * Anything else that is not in the adapter's sampling_params is rejected as unsupported_parameter.
 */
export const IGNORED_REQUEST_FIELDS: readonly string[] = ["user", "metadata", "stream_options", "store"];

/** Fields structurally handled by the bridge rather than forwarded as sampling params. */
export const STRUCTURAL_REQUEST_FIELDS: readonly string[] = ["model", "messages", "stream"];

export type QuotaStatus = "ok" | "low" | "exhausted" | "unknown";

/** The `bridge` extension attached to every completion and chunk. */
export interface BridgeMetadata {
  schema_version: string;
  request_id: string;
  connection_id: string;
  provider: string;
  connection_kind: ConnectionKind;
  route: "A" | "B" | "C" | "test";
  consumption: Consumption;
  /** Model name the provider reported (or the page displayed); null when it said nothing. */
  provider_model: string | null;
  /** How far provider_model can be trusted. */
  model_confidence: ModelConfidence;
  local_or_remote: "local" | "remote";
  quota_status: QuotaStatus;
  /** Set on streamed responses: whether chunks reflect real incremental output. */
  streaming?: Exclude<StreamingSupport, "none">;
  /** How this connection produces tool calls: a real interface, or a text protocol the bridge reads back. */
  tools?: ToolSupport;
  /** True when a pre-approved fallback served the request instead of the first choice. */
  route_changed: boolean;
  /** "provider" when usage numbers came from the provider; "unavailable" when omitted. */
  usage_source: "provider" | "unavailable";
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type FinishReason = "stop" | "length" | "content_filter" | "tool_calls" | null;

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: { role: "assistant"; content: string; tool_calls?: ToolCall[] };
    finish_reason: FinishReason;
  }>;
  /** Omitted unless the provider reported real counts. Never estimated silently. */
  usage?: Usage;
  bridge: BridgeMetadata;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: "assistant"; content?: string; tool_calls?: ToolCall[] };
    finish_reason: FinishReason;
  }>;
  usage?: Usage;
  bridge?: BridgeMetadata;
}

export interface ModelListEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  bridge: {
    connection_id: string;
    connection_kind: ConnectionKind;
    route: "A" | "B" | "C" | "test";
    consumption: Consumption;
    model_confidence: ModelConfidence;
    /** Last known state of the connection; "ready" is never assumed for a failing connection. */
    availability: "ready" | "needs_login" | "quota_exhausted" | "provider_unavailable" | "degraded";
    /** Present for aliases: the ordered targets the alias may resolve to (primary first). */
    alias_of?: string[];
  };
}
