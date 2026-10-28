import {
  BridgeError,
  type AdapterCapabilities,
  type ConnectionKind,
  type Consumption,
  type ErrorCode,
  type FinishReason,
  type ToolCall,
  type Usage,
} from "@ownai/contracts";
import { abortError } from "../abort.ts";
import type {
  AdapterHealth,
  AdapterModel,
  AdapterRequest,
  AdapterResult,
  GenerateContext,
  NormalizedMessage,
  ProviderAdapter,
} from "../types.ts";

/**
 * Route C: a provider's own documented OpenAI-compatible HTTP API, called with a key
 * the owner obtained from that provider. Nothing here automates a consumer website —
 * the provider issued this credential for exactly this kind of call.
 *
 * Capabilities are supplied by the preset rather than assumed: a connection may only
 * claim what has actually been verified (TRUTH-3).
 */

export interface OpenAiCompatOptions {
  type: string;
  provider: string;
  kind: ConnectionKind;
  consumption: Consumption;
  /** Root that `/chat/completions` and `/models` hang off, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  /** Resolved from the OS credential store on every call, so a rotated key takes effect at once. */
  readApiKey?: () => Promise<string | null>;
  /** False for a server on this machine that asks for no credential, e.g. Ollama. */
  requiresApiKey?: boolean;
  /** False when the provider documents no `/models` route; its 404 is then not a failure. */
  modelsList?: boolean;
  capabilities: AdapterCapabilities;
  /** Provider-mandated extras, such as an attribution header. Never a user agent or fingerprint. */
  headers?: Record<string, string>;
  /** Set only by the custom preset, where the owner supplies the model name themselves. */
  modelsOnGenerate?: boolean;
  fetchImpl?: typeof fetch;
}

interface StreamedToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly type: string;
  readonly provider: string;
  readonly kind: ConnectionKind;
  readonly consumption: Consumption;

  constructor(private readonly options: OpenAiCompatOptions) {
    this.type = options.type;
    this.provider = options.provider;
    this.kind = options.kind;
    this.consumption = options.consumption;
  }

  capabilities(): AdapterCapabilities {
    return this.options.capabilities;
  }

  async listModels(signal?: AbortSignal): Promise<AdapterModel[]> {
    const url = `${this.options.baseUrl}/models`;
    const response = await this.send(url, { method: "GET", ...(signal ? { signal } : {}) });
    // A provider that publishes no model list still answers here, and that answer is
    // the reachability evidence health() needs. Only a 404 is tolerated.
    if (!response.ok) {
      if (response.status === 404 && this.options.modelsList === false) return [];
      throw await this.failure(response, false);
    }
    const body = (await response.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }> } | undefined;
    const ids = (body?.data ?? [])
      .map((entry) => (typeof entry.id === "string" ? entry.id : undefined))
      .filter((id): id is string => Boolean(id));
    // The provider named these itself, which is the strongest claim available for a model ID.
    return ids.map((id) => ({ id, confidence: "verified" as const }));
  }

  async health(signal?: AbortSignal): Promise<AdapterHealth> {
    if (this.needsKey && !(await this.apiKey())) {
      return { state: "needs_login", detail: `No ${this.provider} API key is stored.` };
    }
    try {
      await this.listModels(signal);
      return { state: "ready" };
    } catch (err) {
      if (err instanceof BridgeError) {
        const state = codeToHealth(err.code);
        return { state, detail: err.message };
      }
      throw err;
    }
  }

  async generate(request: AdapterRequest, ctx: GenerateContext): Promise<AdapterResult> {
    if (this.needsKey && !(await this.apiKey())) {
      throw new BridgeError("login_required", `No ${this.provider} API key is stored for this connection.`);
    }
    const stream = Boolean(ctx.onDelta) && this.capabilities().streaming === "native";
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toProviderMessage),
      stream,
      ...request.params,
    };
    if (request.tools?.length) {
      payload.tools = request.tools;
      if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
    }
    // The router already refused this field unless json_mode is declared, so reaching
    // here means the provider is expected to honour it.
    if (request.response_format !== undefined) payload.response_format = request.response_format;

    // From here the prompt may exist on the provider's side, so every failure says so
    // and the router will not re-send it to another connection (ADR-005).
    let response: Response;
    try {
      response = await this.send(
        `${this.options.baseUrl}/chat/completions`,
        { method: "POST", body: JSON.stringify(payload), signal: ctx.signal },
        true,
      );
    } catch (err) {
      if (ctx.signal.aborted) throw abortError(ctx.signal, true);
      throw asProviderError(err, this.provider, true);
    }
    if (!response.ok) throw await this.failure(response, true);

    try {
      return stream
        ? await this.readStream(response, request.model, ctx)
        : this.readCompletion((await response.json()) as ProviderCompletion, request.model);
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (ctx.signal.aborted) throw abortError(ctx.signal, true);
      throw asProviderError(err, this.provider, true);
    }
  }

  async close(): Promise<void> {}

  private get needsKey(): boolean {
    return this.options.requiresApiKey !== false;
  }

  private apiKey(): Promise<string | null> {
    if (!this.options.readApiKey) return Promise.resolve(null);
    return this.options.readApiKey().catch(() => null);
  }

  private async send(url: string, init: RequestInit, generationStarted = false): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const key = await this.apiKey();
    const headers: RequestHeaderRecord = { "content-type": "application/json", ...this.options.headers };
    if (key) headers.authorization = `Bearer ${key}`;
    else if (this.needsKey) {
      throw new BridgeError("login_required", `No ${this.provider} API key is stored for this connection.`);
    }
    return fetchImpl(url, { ...init, headers }).catch((err: unknown) => {
      throw asProviderError(err, this.provider, generationStarted);
    });
  }

  /** Turns a provider status into the bridge's vocabulary, keeping the two 429 kinds apart. */
  private async failure(response: Response, generationStarted: boolean): Promise<BridgeError> {
    const detail = await readProviderMessage(response);
    const status = response.status;
    let code: ErrorCode = "provider_error";
    if (status === 401 || status === 403) code = "login_required";
    else if (status === 404) code = detail.toLowerCase().includes("model") ? "model_not_found" : "provider_error";
    else if (status === 429) code = quotaWording(detail) ? "quota_exhausted" : "rate_limited";
    else if (status >= 500) code = "provider_unavailable";
    else if (status === 400 || status === 422) code = "invalid_request";

    const retryAfter = Number(response.headers.get("retry-after"));
    return new BridgeError(code, `${this.provider} (${status}): ${detail}`, {
      provider: this.provider,
      generation_started: generationStarted,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retry_after_s: Math.round(retryAfter) } : {}),
    });
  }

  /**
   * Tool-call fragments arrive split across chunks. They are stitched here and handed
   * over whole, because a client cannot execute a half-parsed argument string.
   */
  private async readStream(response: Response, model: string, ctx: GenerateContext): Promise<AdapterResult> {
    const parts: string[] = [];
    const toolCalls = new Map<number, StreamedToolCall>();
    let finish: FinishReason = null;
    let providerModel: string | undefined;
    let usage: Usage | undefined;

    for await (const event of readSse(response.body, ctx.signal)) {
      for (const chunk of event) {
        providerModel ??= typeof chunk.model === "string" ? chunk.model : undefined;
        usage = chunk.usage ? normalizeUsage(chunk.usage) : usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          parts.push(delta.content);
          ctx.onDelta?.({ text: delta.content });
        }
        for (const fragment of delta.tool_calls ?? []) {
          const index = fragment.index ?? 0;
          const current = toolCalls.get(index) ?? { arguments: "" };
          toolCalls.set(index, {
            id: fragment.id ?? current.id,
            name: fragment.function?.name ?? current.name,
            arguments: current.arguments + (fragment.function?.arguments ?? ""),
          });
        }
        if (choice.finish_reason) finish = mapFinishReason(choice.finish_reason);
      }
    }

    const calls = assembledToolCalls(toolCalls);
    if (calls.length > 0) {
      finish = "tool_calls";
      ctx.onDelta?.({ tool_calls: calls });
    }
    if (ctx.signal.aborted) throw abortError(ctx.signal, true);
    if (parts.length === 0 && calls.length === 0 && finish === null) {
      throw new BridgeError("provider_error", `${this.provider} streamed no content.`, {
        provider: this.provider,
        generation_started: true,
      });
    }
    return {
      text: parts.join(""),
      finish_reason: finish,
      model: providerModel ?? model,
      model_confidence: providerModel ? "verified" : "unknown",
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
      ...(usage ? { quota_status: "ok" as const, usage } : {}),
    };
  }

  private readCompletion(body: ProviderCompletion, model: string): AdapterResult {
    const choice = body.choices?.[0];
    if (!choice) {
      throw new BridgeError("provider_error", `${this.provider} returned no completion choice.`, {
        provider: this.provider,
        generation_started: true,
      });
    }
    const calls = choice.message?.tool_calls ?? [];
    const usage = body.usage ? normalizeUsage(body.usage) : undefined;
    return {
      text: typeof choice.message?.content === "string" ? choice.message.content : "",
      finish_reason: calls.length > 0 ? "tool_calls" : mapFinishReason(choice.finish_reason),
      model: typeof body.model === "string" ? body.model : model,
      model_confidence: typeof body.model === "string" ? "verified" : "unknown",
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
      ...(usage ? { quota_status: "ok" as const, usage } : {}),
    };
  }
}

function toProviderMessage(message: NormalizedMessage): Record<string, unknown> {
  return {
    role: message.role,
    // A tool turn, and an assistant turn that only asks for a call, carry no text.
    content: message.content ?? (message.tool_calls?.length ? null : ""),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

function assembledToolCalls(partial: Map<number, StreamedToolCall>): ToolCall[] {
  const out: ToolCall[] = [];
  for (const entry of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    const call = entry[1];
    if (!call.id || !call.name) continue; // Nothing callable without both, so nothing is claimed.
    out.push({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } });
  }
  return out;
}

/** Providers use several spellings and field names for the same three counts. */
function normalizeUsage(raw: ProviderUsage): Usage | undefined {
  const prompt = raw.prompt_tokens ?? raw.input_tokens;
  const completion = raw.completion_tokens ?? raw.output_tokens;
  const total = raw.total_tokens ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
  if (typeof prompt !== "number" || typeof completion !== "number" || typeof total !== "number") return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/** "length" and "content_filter" mean what they say; anything else ended normally. */
function mapFinishReason(value: string | null | undefined): FinishReason {
  switch (value) {
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case null:
    case undefined:
      return null;
    default:
      return "stop";
  }
}

function codeToHealth(code: ErrorCode): AdapterHealth["state"] {
  if (code === "login_required") return "needs_login";
  if (code === "quota_exhausted" || code === "rate_limited") return "quota_exhausted";
  if (code === "provider_unavailable" || code === "timeout") return "provider_unavailable";
  return "degraded";
}

function quotaWording(detail: string): boolean {
  return /quota|credit|balance|billing|spend|limit reached|exhaust/i.test(detail);
}

function asProviderError(err: unknown, provider: string, generationStarted: boolean): BridgeError {
  if (err instanceof BridgeError) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new BridgeError("provider_unavailable", `Could not reach ${provider}: ${reason.slice(0, 200)}`, {
    provider,
    generation_started: generationStarted,
  });
}

async function readProviderMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let message = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed.error?.message ?? parsed.message;
    if (typeof inner === "string" && inner.length > 0) message = inner;
  } catch {
    // Not JSON: the raw text is the best description available.
  }
  return message.slice(0, 300) || "no detail";
}

interface ProviderCompletion {
  model?: unknown;
  usage?: ProviderUsage;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: unknown; tool_calls?: ToolCall[] };
  }>;
}

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface ProviderChunk {
  model?: unknown;
  usage?: ProviderUsage;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
  }>;
}

type RequestHeaderRecord = Record<string, string>;

/**
 * Splits a live byte stream into SSE events. Buffering is deliberate: an event can
 * arrive across two network chunks, and treating a half-event as data would corrupt it.
 */
async function* readSse(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): AsyncGenerator<ProviderChunk[]> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) {
        await reader.cancel();
        throw abortError(signal, true);
      }
      buffer += decoder.decode(value, { stream: true });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const chunks = parseEvent(raw);
        if (chunks.length > 0) yield chunks;
        match = /\r?\n\r?\n/.exec(buffer);
      }
    }
    const trailing = parseEvent(buffer);
    if (trailing.length > 0) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): ProviderChunk[] {
  const out: ProviderChunk[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue; // Comments and `event:` lines carry nothing we act on.
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      out.push(JSON.parse(data) as ProviderChunk);
    } catch {
      // A malformed frame is dropped rather than guessed at; a truncated reply is
      // reported by the missing finish_reason, not papered over.
    }
  }
  return out;
}
