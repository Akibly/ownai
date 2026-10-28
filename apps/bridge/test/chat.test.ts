import { describe, expect, it } from "vitest";
import type { SiteConnector } from "@ownai/adapters";
import type { AdapterCapabilities, ChatCompletionRequest, ToolSupport } from "@ownai/contracts";
import { claudeConnection } from "../src/connections.ts";
import { startOfLocalDay } from "../src/policy.ts";
import { assertRequestCapabilities, normalizeMessages } from "../src/validation.ts";
import { chatRequest, makeHarness } from "./helpers.ts";

/** T01, T03, T04, T17 and the streaming-honesty cases (FR-01, FR-08, TRUTH-1, TRUTH-3, SEC-L3). */
describe("chat completions", () => {
  it("T01: serves a valid local request with honest source metadata", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("mock", "hello world"));

    expect(res.statusCode).toBe(200);
    expect(res.body.choices[0].message).toEqual({ role: "assistant", content: "Mock reply: hello world" });
    expect(res.body.choices[0].index).toBe(0);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.bridge).toMatchObject({
      connection_id: "mock",
      provider: "Mock provider",
      route: "test",
      consumption: "none",
      provider_model: "mock-echo",
      model_confidence: "verified",
      local_or_remote: "local",
      route_changed: false,
    });
    expect(res.body.bridge.schema_version).toBeTruthy();
    await harness.app.close();
  });

  it("T03: an unreachable model is a 404 naming the parameter", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("claude", "hi"));

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("model_not_found");
    expect(res.body.error.param).toBe("model");
    await harness.app.close();
  });

  it("T04: a tool call on a connection without tool support is refused, not degraded", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("mock", "hi", { tools: [{ type: "function", function: { name: "x" } }] }));

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("unsupported_feature");
    expect(res.body.error.bridge.capability).toBe("tools");
    await harness.app.close();
  });

  it("T04b: a tool-role message is refused for the same reason", async () => {
    const harness = await makeHarness();
    const res = await harness.post({
      model: "mock",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "1", content: "ok" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("unsupported_feature");
    await harness.app.close();
  });

  it("T17: token counts are absent rather than invented", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("mock"));

    expect(res.body.usage).toBeUndefined();
    expect(res.body.bridge.usage_source).toBe("unavailable");
    await harness.app.close();
  });

  it("streams natively when the adapter really produces increments (FR-08)", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("mock", "one two three", { stream: true }));

    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.payload.split("\n\n").filter((block) => block.startsWith("data:"));
    expect(events.at(-1)).toBe("data: [DONE]");

    const chunks = events.slice(0, -1).map((block) => JSON.parse(block.replace("data: ", "")));
    const content = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("Mock reply: one two three");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1).bridge.streaming).toBe("native");
    await harness.app.close();
  });

  it("SEC-L3: a malformed body is a 400, never a silent empty reply", async () => {
    const harness = await makeHarness();
    const res = await harness.post({ model: "mock", messages: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    await harness.app.close();
  });

  it("refuses a sampling parameter the connection does not honour", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("mock", "hi", { temperature: 0.7 }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("unsupported_parameter");
    expect(res.body.error.param).toBe("temperature");
    await harness.app.close();
  });

  it("accepts a parameter the connection does honour", async () => {
    const harness = await makeHarness();
    const res = await harness.post(chatRequest("mock", "alpha beta gamma delta", { max_tokens: 2 }));
    expect(res.statusCode).toBe(200);
    expect(res.body.choices[0].finish_reason).toBe("length");
    await harness.app.close();
  });
});

/** The tri-state gate itself, so "emulated" is a real permission and not decoration. */
describe("tool capability declarations", () => {
  const base: AdapterCapabilities = {
    text_input: true,
    text_output: true,
    system_role: "native",
    multi_turn: "native",
    streaming: "native",
    tools: "none",
    vision: false,
    json_mode: false,
    sampling_params: [],
    context_window: null,
  };
  const declares = (tools: ToolSupport): AdapterCapabilities => ({ ...base, tools });
  const refusal = (run: () => unknown): string | undefined => {
    try {
      run();
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };
  const toolRequest = { model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] } as ChatCompletionRequest;

  it.each(["native", "emulated"] as const)("lets a %s route receive tool definitions", (tools) => {
    expect(refusal(() => assertRequestCapabilities(declares(tools), toolRequest))).toBeUndefined();
  });

  it("refuses only a route that declares none", () => {
    expect(refusal(() => assertRequestCapabilities(declares("none"), toolRequest))).toBe("unsupported_feature");
  });

  it("carries a tool result into an emulated route, because that turn answers its call", () => {
    const messages = normalizeMessages(
      [
        { role: "user", content: "weather?" },
        { role: "tool", tool_call_id: "call_1", content: "22 degrees" },
      ],
      declares("emulated"),
    );
    expect(messages[1]).toEqual({ role: "tool", content: "22 degrees", tool_call_id: "call_1" });
  });
});

/**
 * The opt-in served end to end: a page's block becomes a call the client can run, and the
 * metadata reports the mechanism and the streaming the client actually received.
 */
describe("prompt-mediated tools through the bridge", () => {
  const weather = {
    type: "function",
    function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
  };

  /** A native-streaming site that answers with a protocol block after its own prose. */
  function toolSite(): SiteConnector {
    return {
      id: "claude",
      displayName: "Stub site",
      startUrl: "about:blank",
      loginUrl: "about:blank",
      consumption: "free_quota",
      streaming: "native",
      isSignedIn: async () => true,
      detectChallenge: async () => false,
      newConversation: async () => {},
      submitPrompt: async () => {},
      readReply: async () => ({
        text: 'Checking now.\n```ownai_tool\n{"name":"get_weather","arguments":{"city":"Ankara"}}\n```',
        finish_reason: "stop" as const,
      }),
      stopGeneration: async () => {},
      modelLabel: async () => null,
    };
  }

  it("turns a page's block into a tool call and labels how it was produced", async () => {
    const harness = await makeHarness({
      connections: [claudeConnection({ personalUse: true, promptTools: true, mode: "background" })],
      connectors: { "browser:claude": () => toolSite() },
    });
    const res = await harness.post({
      model: "claude",
      messages: [{ role: "user", content: "weather in Ankara?" }],
      tools: [weather],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.choices[0].finish_reason).toBe("tool_calls");
    expect(res.body.choices[0].message.tool_calls[0].function).toEqual({
      name: "get_weather",
      arguments: '{"city":"Ankara"}',
    });
    // The call is handed over, not shown as the model's prose.
    expect(res.body.choices[0].message.content).toBe("Checking now.");
    expect(res.body.bridge.tools).toBe("emulated");
    // A call is only known once the reply ends, so this turn did not stream, whatever
    // the connection can normally do.
    expect(res.body.bridge.streaming).toBe("buffered");
    await harness.app.close();
  }, 60_000);

  it("still refuses tools on the same site until the owner opts in", async () => {
    const harness = await makeHarness({
      connections: [claudeConnection({ personalUse: true, mode: "background" })],
      connectors: { "browser:claude": () => toolSite() },
    });
    const res = await harness.post({
      model: "claude",
      messages: [{ role: "user", content: "weather in Ankara?" }],
      tools: [weather],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("unsupported_feature");
    expect(res.body.error.message).toBe("This connection cannot call tools.");
    await harness.app.close();
  }, 60_000);
});

describe("turn accounting", () => {
  it("costs no allowance when the page never takes a prompt", async () => {
    const record = claudeConnection({ personalUse: true, mode: "background" });
    const signedOut: SiteConnector = {
      id: "claude",
      displayName: "Stub site",
      startUrl: "about:blank",
      loginUrl: "about:blank",
      consumption: "free_quota",
      streaming: "native",
      isSignedIn: async () => false,
      detectChallenge: async () => false,
      newConversation: async () => {},
      submitPrompt: async () => {},
      readReply: async () => ({ text: "never reached", finish_reason: "stop" as const }),
      stopGeneration: async () => {},
      modelLabel: async () => null,
    };
    const harness = await makeHarness({
      connections: [record],
      connectors: { "browser:claude": () => signedOut },
    });
    const since = startOfLocalDay(Date.now());

    const res = await harness.post({ model: "claude", messages: [{ role: "user", content: "hello" }] });

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("login_required");
    // The attempt stays in the log for the console, but the account's own allowance was
    // not touched, so the daily limit must not charge for it.
    expect(harness.store.countEventsFor(record.id, since)).toBe(1);
    expect(harness.store.countTurnsFor(record.id, since)).toBe(0);
    await harness.app.close();
  }, 60_000);
});
