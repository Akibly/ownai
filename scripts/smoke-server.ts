import { createRequire } from "node:module";
import { BridgeStore } from "../apps/bridge/src/stores/store.ts";
import { MemorySecretStore } from "../apps/bridge/src/secrets.ts";
import { createRuntime } from "../apps/bridge/src/runtime.ts";
import { startBridge } from "../apps/bridge/src/server.ts";

/**
 * Phase 1 exit check against a real listening socket, not Fastify inject(): plain
 * fetch plus the OpenAI Node SDK. Uses the mock adapter and an in-memory secret
 * store, so it touches neither a provider account nor the OS credential store.
 *
 * Run: pnpm exec tsx scripts/smoke-server.ts
 */

const requireFromBridge = createRequire(new URL("../apps/bridge/package.json", import.meta.url));

const store = BridgeStore.inMemory();
const runtime = createRuntime({ store, secrets: new MemorySecretStore() });
const key = await runtime.ensureGatewayKey();
const running = await startBridge({ store, registry: runtime.registry, router: runtime.router, port: 0 });
const base = `${running.url}/v1`;
const auth = { Authorization: `Bearer ${key.plaintext}` };

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

try {
  const health = await fetch(`${running.url}/health`).then((r) => r.json());
  check("GET /health", health.status === "ok" && health.transport === "loopback-only");

  const noKey = await fetch(`${base}/models`);
  check("no key is refused", noKey.status === 401);

  const models = await fetch(`${base}/models`, { headers: auth }).then((r) => r.json());
  check("GET /v1/models", models.object === "list" && models.data.some((m: { id: string }) => m.id === "mock"));

  const completion = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "real socket test" }] }),
  }).then((r) => r.json());
  check(
    "POST non-streaming completion",
    completion.choices?.[0]?.message?.content === "Mock reply: real socket test",
    JSON.stringify(completion.bridge ?? completion),
  );

  const streamed = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "stream please" }], stream: true }),
  });
  const sse = await streamed.text();
  const seen = [...sse.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("POST streaming SSE", sse.includes("data: [DONE]") && seen.includes("Mock reply: stream please"));

  const OpenAI = requireFromBridge("openai").default;
  const client = new OpenAI({ apiKey: key.plaintext, baseURL: base, maxRetries: 0 });
  const viaSdk = await client.chat.completions.create({ model: "mock", messages: [{ role: "user", content: "sdk check" }] });
  check("OpenAI Node SDK", viaSdk.choices[0]?.message?.content === "Mock reply: sdk check");

  const viaSdkStream = await client.chat.completions.create({
    model: "mock",
    messages: [{ role: "user", content: "sdk stream" }],
    stream: true,
  });
  let sdkText = "";
  for await (const chunk of viaSdkStream) sdkText += chunk.choices[0]?.delta?.content ?? "";
  check("OpenAI SDK streaming", sdkText === "Mock reply: sdk stream", sdkText);
} finally {
  await running.close();
  await runtime.close();
}

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`);
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
