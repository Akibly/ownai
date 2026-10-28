import { randomBytes } from "node:crypto";
import {
  BridgeError,
  CONNECTION_KIND_ROUTE,
  SCHEMA_VERSION,
  isBridgeError,
  type AdapterCapabilities,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ConnectionRecord,
  type ModelListEntry,
} from "@ownai/contracts";
import type { AdapterResult, InteractiveLoginOptions, OutputDelta } from "@ownai/adapters";
import type { BridgeStore } from "./stores/store.ts";
import type { AdapterRegistry } from "./registry.ts";
import { assertTrafficAllowed, startOfLocalDay, TurnBudget } from "./policy.ts";
import { assertRequestCapabilities, extractSamplingParams, normalizeMessages } from "./validation.ts";

/**
 * Resolves a requested model to exactly one concrete connection and serves it
 * (ADR-005). Fallback happens only to destinations the user listed, and only while
 * the prompt is certain not to have reached the first provider.
 */

const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const FALLBACKABLE = new Set(["provider_unavailable", "timeout", "login_required", "quota_exhausted"]);

export interface RouterOptions {
  store: BridgeStore;
  registry: AdapterRegistry;
  /** Injected in tests; production counts turns from the local event log. */
  turnsToday?: (connectionId: string) => number;
  now?: () => number;
}

export interface CompleteOptions {
  requestId: string;
  signal?: AbortSignal;
  /** Called per delta only when the serving adapter streams natively. */
  onDelta?: (delta: OutputDelta) => void;
  totalTimeoutMs?: number;
  /** Route A is loopback-only by construction; a relay would have to set "remote". */
  localOrRemote?: "local" | "remote";
}

export class Router {
  private readonly budget: TurnBudget;

  constructor(private readonly options: RouterOptions) {
    const now = options.now ?? Date.now;
    this.budget = new TurnBudget(
      options.turnsToday ?? ((id) => this.options.store.countEventsFor(id, startOfLocalDay(now()))),
      now,
    );
  }

  /** `alias`, `connection-id`, or `connection-id/provider-model` all resolve. */
  resolve(model: string): ConnectionRecord {
    const requested = model.trim();
    const match = this.options.store
      .listConnections()
      .find((c) => c.alias === requested || c.id === requested || `${c.id}/${c.model}` === requested || `${c.alias}/${c.model}` === requested);
    if (!match) {
      throw new BridgeError("model_not_found", `No connection is reachable as "${model}".`, { param: "model" });
    }
    assertTrafficAllowed(match);
    return match;
  }

  async capabilities(connectionId: string): Promise<{ record: ConnectionRecord; capabilities: AdapterCapabilities }> {
    const record = this.resolve(connectionId);
    const adapter = await this.options.registry.get(record);
    return { record, capabilities: adapter.capabilities() };
  }

  /**
   * Opens the provider's own sign-in page in a visible window so the human completes
   * it (ADR-015). The bridge never submits credentials and never touches a challenge.
   */
  async interactiveLogin(connectionId: string, signal?: AbortSignal): Promise<void> {
    const record = this.resolve(connectionId);
    const adapter = await this.options.registry.get(record);
    if (!("interactiveLogin" in adapter)) {
      throw new BridgeError("unsupported_feature", `"${record.id}" is not a browser connection.`, {
        capability: "login",
      });
    }
    await (adapter as BrowserCapable).interactiveLogin({ ...(signal ? { signal } : {}), headless: false });
  }

  async health(connectionId: string): Promise<{ state: string; detail?: string }> {
    const record = this.resolve(connectionId);
    const adapter = await this.options.registry.get(record);
    return adapter.health();
  }

  /**
   * The owner asked "does this connection work?", so consult the provider rather than
   * answer from local state. Routes that have nothing to consult keep health()'s answer.
   */
  async probe(connectionId: string, signal?: AbortSignal): Promise<{ state: string; detail?: string }> {
    const record = this.resolve(connectionId);
    const adapter = await this.options.registry.get(record);
    return adapter.probe ? adapter.probe(signal) : adapter.health(signal);
  }

  async listModels(): Promise<ModelListEntry[]> {
    const entries: ModelListEntry[] = [];
    for (const record of this.options.store.listConnections()) {
      let availability: ModelListEntry["bridge"]["availability"] = "provider_unavailable";
      let providerIds: string[] = [];
      let confidence: ModelListEntry["bridge"]["model_confidence"] = "unknown";
      try {
        assertTrafficAllowed(record);
        const adapter = await this.options.registry.get(record);
        availability = (await adapter.health()).state;
        const models = await adapter.listModels();
        // A connection is pinned to its configured model. Do not advertise other
        // provider models that this route would silently replace at generation time.
        providerIds = models.filter((m) => m.id === record.model).map((m) => m.id);
        confidence = models.find((m) => m.id === record.model)?.confidence ?? "unknown";
      } catch {
        availability = "provider_unavailable";
      }
      const base = {
        object: "model" as const,
        created: 0,
        owned_by: record.provider,
        bridge: {
          connection_id: record.id,
          connection_kind: record.kind,
          route: CONNECTION_KIND_ROUTE[record.kind],
          consumption: record.consumption,
          model_confidence: confidence,
          availability,
        },
      };
      entries.push({ ...base, id: record.alias });
      for (const id of providerIds) entries.push({ ...base, id: `${record.alias}/${id}` });
    }
    return entries;
  }

  async complete(request: ChatCompletionRequest, opts: CompleteOptions): Promise<ChatCompletionResponse> {
    const primary = this.resolve(request.model);
    const chain = [primary, ...this.approvedFallbacks(primary)];
    let lastError: BridgeError | undefined;

    for (const [index, record] of chain.entries()) {
      try {
        return await this.serve(record, request, opts, index > 0);
      } catch (err) {
        if (!isBridgeError(err)) throw err;
        lastError = err;
        // A prompt that may already have reached a provider is never re-sent (ADR-005).
        const canMoveOn = err.details.generation_started !== true && FALLBACKABLE.has(err.code);
        if (!canMoveOn || index === chain.length - 1) throw err;
      }
    }
    throw lastError ?? new BridgeError("internal_error", "No route was attempted.");
  }

  private async serve(
    record: ConnectionRecord,
    request: ChatCompletionRequest,
    opts: CompleteOptions,
    routeChanged: boolean,
  ): Promise<ChatCompletionResponse> {
    assertTrafficAllowed(record);
    this.budget.check(record);

    const adapter = await this.options.registry.get(record);
    const capabilities = adapter.capabilities();
    assertRequestCapabilities(capabilities, request);
    const params = extractSamplingParams(request, capabilities);
    const messages = normalizeMessages(request.messages, capabilities);

    const client = opts.signal ?? new AbortController().signal;
    const signal = AbortSignal.any([
      client,
      AbortSignal.timeout(opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS),
    ]);

    const bytesIn = byteLength(messages.map((m) => m.content).join(""));
    const started = Date.now();
    this.budget.mark(record);

    let result: AdapterResult;
    try {
      result = await adapter.generate(
        {
          model: record.model,
          messages,
          params,
          ...(request.tools?.length ? { tools: request.tools } : {}),
          ...(request.tool_choice !== undefined ? { tool_choice: request.tool_choice } : {}),
          ...(request.response_format !== undefined ? { response_format: request.response_format } : {}),
        },
        { signal, onDelta: capabilities.streaming === "native" ? opts.onDelta : undefined },
      );
    } catch (err) {
      this.record(record, opts, "unknown", err, started, bytesIn, 0);
      throw err;
    }
    this.record(
      record,
      opts,
      result.model_confidence,
      null,
      started,
      bytesIn,
      byteLength(result.text) + byteLength(JSON.stringify(result.tool_calls ?? [])),
    );

    const bridge: BridgeMetadataShape = {
      schema_version: SCHEMA_VERSION,
      request_id: opts.requestId,
      connection_id: record.id,
      provider: record.provider,
      connection_kind: record.kind,
      route: CONNECTION_KIND_ROUTE[record.kind],
      consumption: record.consumption,
      provider_model: result.model,
      model_confidence: result.model_confidence,
      local_or_remote: opts.localOrRemote ?? "local",
      quota_status: result.quota_status ?? "unknown",
      route_changed: routeChanged,
      usage_source: result.usage ? "provider" : "unavailable",
    };
    // ADR-017: label how the bytes the client sees relate to real provider output.
    if (capabilities.streaming !== "none") bridge.streaming = capabilities.streaming;

    return {
      id: `chatcmpl-${randomBytes(9).toString("base64url")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: result.text,
            ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}),
          },
          finish_reason: result.finish_reason,
        },
      ],
      ...(result.usage ? { usage: result.usage } : {}),
      bridge,
    };
  }

  private record(
    record: ConnectionRecord,
    opts: CompleteOptions,
    modelConfidence: string,
    err: unknown,
    started: number,
    bytesIn: number,
    bytesOut: number,
  ): void {
    this.options.store.recordEvent({
      request_id: opts.requestId,
      connection_id: record.id,
      route: CONNECTION_KIND_ROUTE[record.kind],
      consumption: record.consumption,
      model_confidence: modelConfidence,
      outcome: err ? (isBridgeError(err) ? err.code : "internal_error") : "ok",
      duration_ms: Date.now() - started,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
    });
  }

  private approvedFallbacks(record: ConnectionRecord): ConnectionRecord[] {
    return record.fallback_ids
      .map((id) => this.options.store.getConnection(id))
      .filter((c): c is ConnectionRecord => c !== undefined && c.enabled);
  }
}

/** BridgeMetadata minus the streaming-only field, which is assigned after construction. */
type BridgeMetadataShape = Omit<ChatCompletionResponse["bridge"], "streaming"> & {
  streaming?: ChatCompletionResponse["bridge"]["streaming"];
};

/** Only browser adapters can hand a human a sign-in window. */
interface BrowserCapable {
  interactiveLogin(options?: InteractiveLoginOptions): Promise<void>;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
