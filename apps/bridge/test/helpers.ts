import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionRequest, ConnectionRecord } from "@ownai/contracts";
import { MockAdapter, type ProviderAdapter } from "@ownai/adapters";
import { AdapterRegistry } from "../src/registry.ts";
import { buildApp } from "../src/server.ts";
import { Router } from "../src/router.ts";
import { BridgeStore } from "../src/stores/store.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { hashGatewayKey, newGatewayKey } from "../src/auth.ts";
import { mockConnection } from "../src/connections.ts";

/** Shared Phase 1 test harness: in-memory store, no port binding, no OS keychain. */

export const TEST_PORT = 8791;

export interface HarnessOptions {
  connections?: ConnectionRecord[];
  connectors?: ConstructorParameters<typeof AdapterRegistry>[0]["connectors"];
  now?: () => number;
  turnsToday?: (id: string) => number;
  originAllowlist?: string[];
  secrets?: string[];
  revealGatewayKey?: () => Promise<string | null>;
}

export interface Harness {
  app: ReturnType<typeof buildApp>["app"];
  router: Router;
  registry: AdapterRegistry;
  store: BridgeStore;
  key: string;
  adapters: Map<string, ProviderAdapter>;
  post(body: unknown, extra?: Record<string, string>): Promise<InjectResult>;
  get(url: string, extra?: Record<string, string>): Promise<InjectResult>;
  patch(url: string, body: unknown, extra?: Record<string, string>): Promise<InjectResult>;
}

export interface InjectResult {
  statusCode: number;
  body: any;
  payload: string;
  headers: Record<string, string | string[] | undefined>;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const store = BridgeStore.inMemory();
  const connections = options.connections ?? [mockConnection()];
  for (const record of connections) store.upsertConnection(record);

  const key = newGatewayKey();
  store.addKey("test-key", "test", hashGatewayKey(key));

  const registry = new AdapterRegistry({
    dataDir: join(tmpdir(), `ownai-test-${Math.random().toString(36).slice(2)}`),
    ...(options.connectors ? { connectors: options.connectors } : {}),
  });
  const router = new Router({
    store,
    registry,
    ...(options.now ? { now: options.now } : {}),
    ...(options.turnsToday ? { turnsToday: options.turnsToday } : {}),
  });
  const { app } = buildApp({
    store,
    registry,
    router,
    port: TEST_PORT,
    originAllowlist: options.originAllowlist ?? [],
    secrets: [key, ...(options.secrets ?? [])],
    ...(options.revealGatewayKey ? { revealGatewayKey: options.revealGatewayKey } : {}),
  });
  await app.ready();

  const adapters = new Map<string, ProviderAdapter>();

  async function inject(method: "GET" | "POST" | "PATCH", url: string, payload: unknown, extra: Record<string, string> = {}) {
    const response = await app.inject({
      method,
      url,
      headers: { host: `127.0.0.1:${TEST_PORT}`, authorization: `Bearer ${key}`, ...extra },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      statusCode: response.statusCode,
      body: tryJson(response.payload),
      payload: response.payload,
      headers: response.headers as Record<string, string | string[] | undefined>,
    };
  }

  return {
    app,
    router,
    registry,
    store,
    key,
    adapters,
    post: (body, extra) => inject("POST", "/v1/chat/completions", body, extra),
    get: (url, extra) => inject("GET", url, undefined, extra),
    patch: (url, body, extra) => inject("PATCH", url, body, extra),
  };
}

export function chatRequest(model: string, content = "hello", extra: Record<string, unknown> = {}): ChatCompletionRequest {
  return { model, messages: [{ role: "user", content }], ...extra } as ChatCompletionRequest;
}

/** Pulls the cached MockAdapter so a test can force a provider-side failure. */
export async function mockAdapterFor(harness: Harness, record: ConnectionRecord): Promise<MockAdapter> {
  const adapter = await harness.registry.get(record);
  if (!(adapter instanceof MockAdapter)) throw new Error("connection is not a mock adapter");
  return adapter;
}

export function recordOf(harness: Harness, id: string): ConnectionRecord {
  const record = harness.store.getConnection(id);
  if (!record) throw new Error(`no connection ${id}`);
  return record;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
