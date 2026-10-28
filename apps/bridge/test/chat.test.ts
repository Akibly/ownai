import { describe, expect, it } from "vitest";
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
