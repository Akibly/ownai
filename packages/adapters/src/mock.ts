import { BridgeError, type AdapterCapabilities, type ErrorCode } from "@ownai/contracts";
import { abortError, sleep } from "./abort.ts";
import type {
  AdapterHealth,
  AdapterModel,
  AdapterRequest,
  AdapterResult,
  GenerateContext,
  ProviderAdapter,
} from "./types.ts";

export interface MockAdapterOptions {
  models?: string[];
  /** Delay between streamed words. */
  chunkDelayMs?: number;
  /** Make every request fail with this code until cleared. */
  failWith?: ErrorCode;
  /** Whether a forced failure happens before or after the prompt is "sent". */
  failAfterStart?: boolean;
  /** Text that the mock leaks into an error message, for redaction tests. */
  errorLeak?: string;
}

/**
 * Deterministic in-process provider. Replies "Mock reply: <last user message>",
 * streamed word by word. Used for tests, demos and the first-run self-check.
 */
export class MockAdapter implements ProviderAdapter {
  readonly type = "mock";
  readonly provider = "Mock provider";
  readonly kind = "mock" as const;
  readonly consumption = "none" as const;

  private readonly models: string[];
  private readonly chunkDelayMs: number;
  failWith: ErrorCode | undefined;
  failAfterStart: boolean;
  errorLeak: string | undefined;
  calls = 0;

  constructor(options: MockAdapterOptions = {}) {
    this.models = options.models ?? ["mock-echo"];
    this.chunkDelayMs = options.chunkDelayMs ?? 5;
    this.failWith = options.failWith;
    this.failAfterStart = options.failAfterStart ?? false;
    this.errorLeak = options.errorLeak;
  }

  capabilities(): AdapterCapabilities {
    return {
      text_input: true,
      text_output: true,
      system_role: "native",
      multi_turn: "native",
      streaming: "native",
      tools: "none",
      vision: false,
      json_mode: false,
      sampling_params: ["max_tokens", "max_completion_tokens"],
      context_window: null,
    };
  }

  async listModels(): Promise<AdapterModel[]> {
    return this.models.map((id) => ({ id, confidence: "verified" as const }));
  }

  async health(): Promise<AdapterHealth> {
    if (this.failWith === "login_required") return { state: "needs_login" };
    if (this.failWith === "quota_exhausted") return { state: "quota_exhausted" };
    if (this.failWith === "provider_unavailable") return { state: "provider_unavailable" };
    return { state: "ready" };
  }

  async generate(request: AdapterRequest, ctx: GenerateContext): Promise<AdapterResult> {
    this.calls++;
    if (!this.models.includes(request.model)) {
      throw new BridgeError("model_not_found", `Mock model "${request.model}" does not exist.`);
    }
    if (this.failWith && !this.failAfterStart) throw this.forcedError(false);

    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const words = `Mock reply: ${lastUser?.content ?? ""}`.split(/(\s+)/).filter(Boolean);
    const limit = (request.params.max_completion_tokens ?? request.params.max_tokens) as number | undefined;
    const out: string[] = [];
    let finish: "stop" | "length" = "stop";

    try {
      for (const word of words) {
        if (limit !== undefined && out.filter((w) => w.trim()).length >= limit) {
          finish = "length";
          break;
        }
        await sleep(this.chunkDelayMs, ctx.signal);
        out.push(word);
        ctx.onDelta?.({ text: word });
        if (this.failWith && this.failAfterStart) throw this.forcedError(true);
      }
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw abortError(ctx.signal, true);
    }

    return { text: out.join(""), finish_reason: finish, model: request.model, model_confidence: "verified" };
  }

  async close(): Promise<void> {}

  private forcedError(started: boolean): BridgeError {
    const leak = this.errorLeak ? ` (upstream said: ${this.errorLeak})` : "";
    return new BridgeError(this.failWith!, `Mock provider failure: ${this.failWith}${leak}`, {
      generation_started: started,
    });
  }
}
