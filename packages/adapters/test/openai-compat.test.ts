import { BridgeError, type AdapterCapabilities } from "@ownai/contracts";
import { describe, expect, it } from "vitest";
import { OpenAiCompatAdapter, type OpenAiCompatOptions } from "../src/index.ts";

/**
 * Route C adapter, driven through an injected fetch so no provider is contacted and no
 * key is read from a vault. What is being proven is the contract, not the network:
 * honest streaming, stitched tool calls, and a provider status mapped to the right code.
 */

const CAPS: AdapterCapabilities = {
  text_input: true,
  text_output: true,
  system_role: "native",
  multi_turn: "native",
  streaming: "native",
  tools: "native",
  vision: false,
  json_mode: false,
  sampling_params: ["temperature"],
  context_window: null,
};

interface Call {
  url: string;
  init: RequestInit;
}

function adapter(
  handler: (call: Call) => Response | Promise<Response>,
  over: Partial<OpenAiCompatOptions> = {},
): { api: OpenAiCompatAdapter; calls: Call[] } {
  const calls: Call[] = [];
  const api = new OpenAiCompatAdapter({
    type: "free_api:openai",
    provider: "Test OpenAI",
    kind: "free_api",
    consumption: "paid_credits",
    baseUrl: "http://test.local/v1",
    capabilities: CAPS,
    readApiKey: async () => "sk-test-key",
    fetchImpl: async (url, init) => {
      const call = { url: String(url), init: (init ?? {}) as RequestInit };
      calls.push(call);
      return handler(call);
    },
    ...over,
  });
  return { api, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sse = (...events: string[]) =>
  new Response(events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const req = (over: object = {}) => ({
  model: "gpt-test",
  messages: [{ role: "user" as const, content: "hi" }],
  params: {},
  ...over,
});

const signal = () => new AbortController().signal;

describe("OpenAI-compatible adapter", () => {
  it("returns a plain completion with usage and a verified model", async () => {
    const { api, calls } = adapter(() =>
      json({
        model: "gpt-test-2026",
        choices: [{ finish_reason: "stop", message: { content: "hello there" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    const result = await api.generate(req(), { signal: signal() });
    expect(result.text).toBe("hello there");
    expect(result.finish_reason).toBe("stop");
    expect(result.model).toBe("gpt-test-2026");
    expect(result.model_confidence).toBe("verified");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(result.quota_status).toBe("ok");
    // No onDelta was passed, so the request must not claim stream:true.
    const payload = JSON.parse(String(calls[0]!.init.body)) as { stream: boolean };
    expect(payload.stream).toBe(false);
  });

  it("streams native text deltas in order and stitches the whole reply", async () => {
    const { api, calls } = adapter(() =>
      sse(
        JSON.stringify({ model: "gpt-test-2026", choices: [{ index: 0, delta: { content: "he" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { content: "llo" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ),
    );
    const deltas: string[] = [];
    const result = await api.generate(req(), { signal: signal(), onDelta: (d) => deltas.push(d.text ?? "") });
    expect(deltas).toEqual(["he", "llo"]);
    expect(result.text).toBe("hello");
    expect(result.finish_reason).toBe("stop");
    expect(result.model_confidence).toBe("verified");
    const payload = JSON.parse(String(calls[0]!.init.body)) as { stream: boolean };
    expect(payload.stream).toBe(true);
  });

  it("stitches tool-call fragments split across stream chunks and emits them whole", async () => {
    const { api } = adapter(() =>
      sse(
        JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }] } }],
        }),
        JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      ),
    );
    const emitted: unknown[] = [];
    const result = await api.generate(req({ tools: [{ type: "function", function: { name: "get_weather" } }] }), {
      signal: signal(),
      onDelta: (d) => {
        if (d.tool_calls) emitted.push(...d.tool_calls);
      },
    });
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);
    expect(emitted).toEqual(result.tool_calls);
  });

  it("reports tool_calls from a non-streaming completion", async () => {
    const { api } = adapter(() =>
      json({
        model: "gpt-test-2026",
        choices: [
          {
            finish_reason: "tool_calls",
            message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "add", arguments: '{"a":1}' } }] },
          },
        ],
      }),
    );
    const result = await api.generate(req(), { signal: signal() });
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.text).toBe("");
    expect(result.tool_calls?.[0]?.function.name).toBe("add");
  });

  it("maps provider statuses onto the bridge vocabulary", async () => {
    const cases: Array<[() => Response, string]> = [
      [() => json({ error: { message: "bad key" } }, 401), "login_required"],
      [() => json({ error: { message: "You have exceeded your monthly quota" } }, 429), "quota_exhausted"],
      [() => json({ error: { message: "Too many requests" } }, 429), "rate_limited"],
      [() => new Response("boom", { status: 503 }), "provider_unavailable"],
      [() => json({ error: { message: "The model does not exist" } }, 404), "model_not_found"],
    ];
    for (const [make, code] of cases) {
      const { api } = adapter(make);
      const err = await api.generate(req(), { signal: signal() }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe(code);
    }
  });

  it("refuses before sending when no key is stored, and says so via health", async () => {
    const { api, calls } = adapter(() => json({}), { readApiKey: async () => null });
    const err = await api.generate(req(), { signal: signal() }).catch((e) => e);
    expect((err as BridgeError).code).toBe("login_required");
    expect(calls).toHaveLength(0); // Never hit the network.
    const health = await api.health();
    expect(health.state).toBe("needs_login");
  });

  it("lists models the provider names itself", async () => {
    const { api } = adapter((call) =>
      call.url.endsWith("/models") ? json({ data: [{ id: "a" }, { id: "b" }, { not_id: true }] }) : json({}),
    );
    const models = await api.listModels();
    expect(models).toEqual([
      { id: "a", confidence: "verified" },
      { id: "b", confidence: "verified" },
    ]);
  });

  it("treats a 404 on a provider that lists no models as reachable, not failed", async () => {
    const { api } = adapter(() => new Response("not found", { status: 404 }), { modelsList: false });
    expect(await api.listModels()).toEqual([]);
    expect((await api.health()).state).toBe("ready");
  });
});
