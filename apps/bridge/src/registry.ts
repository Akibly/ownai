import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  API_PRESETS,
  ACCOUNT_SITE_DEFINITIONS,
  AccountSiteConnector,
  BrowserChatAdapter,
  ClaudeConnector,
  MockAdapter,
  MockChatConnector,
  OpenAiCompatAdapter,
  type ProviderAdapter,
  type SiteConnector,
  type AccountSiteDefinition,
  type ClaudeConnectorOptions,
  type SelectorGroup,
} from "@ownai/adapters";
import { BridgeError, type ConnectionRecord } from "@ownai/contracts";
import { providerKeyRef } from "./secrets.ts";

/**
 * Builds and caches one live adapter per connection. Adapters hold real state (a
 * browser profile, an HTTP client), so they are reused until the connection's
 * options change, then closed and rebuilt.
 */

export interface RegistryOptions {
  /** Root for per-connection browser profiles. Never shared between connections. */
  dataDir: string;
  /** Replace or add site connectors by connection type, e.g. to test a layout variant. */
  connectors?: Record<string, (record: ConnectionRecord) => SiteConnector>;
  /**
   * The OS credential store. Route C adapters read their API key through it on every
   * call, so replacing a key in the vault takes effect without rebuilding anything.
   */
  secrets?: { get(ref: string): Promise<string | null> };
}

export class AdapterRegistry {
  private readonly cache = new Map<string, { fingerprint: string; adapter: ProviderAdapter }>();
  private readonly connectors: Record<string, (record: ConnectionRecord) => SiteConnector>;

  constructor(private readonly options: RegistryOptions) {
    this.connectors = {
      "browser:claude": (record) =>
        new ClaudeConnector({
          consumption: record.consumption,
          streaming: record.options.streaming === "native" ? "native" : "buffered",
          newChatUrl: typeof record.options.new_chat_url === "string" ? record.options.new_chat_url : undefined,
          selectors: record.options.selectors as ClaudeConnectorOptions["selectors"],
        }),
      "browser:chatgpt": (record) => this.account(ACCOUNT_SITE_DEFINITIONS.chatgpt, record),
      "browser:grok": (record) => this.account(ACCOUNT_SITE_DEFINITIONS.grok, record),
      "browser:qwen": (record) => this.account(ACCOUNT_SITE_DEFINITIONS.qwen, record),
      "browser:deepseek": (record) => this.account(ACCOUNT_SITE_DEFINITIONS.deepseek, record),
      "browser:mock-chat": (record) => {
        const baseUrl = record.options.base_url;
        if (!baseUrl) throw new BridgeError("invalid_request", `Connection "${record.id}" has no base_url.`);
        return new MockChatConnector(baseUrl);
      },
      ...options.connectors,
    };
  }

  /** Consumer sites share one connector class; the owner's selector edits apply to all of them. */
  private account(definition: AccountSiteDefinition, record: ConnectionRecord): AccountSiteConnector {
    return new AccountSiteConnector(definition, record.consumption, record.options.selectors as Partial<Record<SelectorGroup, string[]>>);
  }

  async get(record: ConnectionRecord): Promise<ProviderAdapter> {    const fingerprint = JSON.stringify([record.options, record.secret_ref, record.model]);
    const cached = this.cache.get(record.id);
    if (cached && cached.fingerprint === fingerprint) return cached.adapter;
    if (cached) {
      await cached.adapter.close().catch(() => {});
      this.cache.delete(record.id);
    }

    const adapter = await this.build(record);
    this.cache.set(record.id, { fingerprint, adapter });
    return adapter;
  }

  /** Sign a connection out of the cached browser context so the next call rebuilds it. */
  async invalidate(id: string): Promise<void> {
    const cached = this.cache.get(id);
    if (!cached) return;
    this.cache.delete(id);
    await cached.adapter.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const entries = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(entries.map((e) => e.adapter.close().catch(() => {})));
  }

  private async build(record: ConnectionRecord): Promise<ProviderAdapter> {
    if (record.type === "mock") {
      return new MockAdapter({ models: [record.model] });
    }
    if (record.type.startsWith("browser:")) {
      const factory = this.connectors[record.type];
      if (!factory) {
        throw new BridgeError("policy_disabled", `No site connector registered for "${record.type}".`, {
          connection_id: record.id,
        });
      }
      return this.browser(record, factory(record));
    }
    // Route C adapters are added as they ship; refuse rather than pretend.
    if (record.type.startsWith("free_api:") || record.type.startsWith("local_model:")) {
      return this.api(record);
    }
    throw new BridgeError(
      "policy_disabled",
      `No adapter is implemented for connection type "${record.type}" yet.`,
      { connection_id: record.id },
    );
  }

  /**
   * A provider's own HTTP API. The preset carries the capabilities, because a person
   * adding a connection cannot be trusted to state them correctly, and an inflated
   * claim would let the bridge promise something the provider does not do.
   */
  private api(record: ConnectionRecord): ProviderAdapter {
    const preset = API_PRESETS[record.type];
    if (!preset) {
      throw new BridgeError("policy_disabled", `No provider preset for "${record.type}".`, {
        connection_id: record.id,
      });
    }
    const configured = typeof record.options.base_url === "string" ? record.options.base_url : "";
    const baseUrl = (configured || preset.baseUrl).replace(/\/$/, "");
    if (!baseUrl) {
      throw new BridgeError("invalid_request", `Connection "${record.id}" has no base_url to call.`, {
        connection_id: record.id,
        param: "base_url",
      });
    }
    const ref = record.secret_ref ?? providerKeyRef(record.id);
    return new OpenAiCompatAdapter({
      type: record.type,
      provider: record.provider,
      kind: record.kind,
      consumption: record.consumption,
      baseUrl,
      capabilities: configuredCapabilities(
        preset.capabilities,
        record.type === "free_api:custom" ? record.options.capabilities : undefined,
      ),
      requiresApiKey: preset.requiresApiKey,
      modelsList: preset.modelsList,
      ...(preset.headers ? { headers: preset.headers } : {}),
      ...(preset.requiresApiKey === false
        ? {}
        : { readApiKey: async () => (this.options.secrets ? await this.options.secrets.get(ref) : null) }),
    });
  }

  private async browser(record: ConnectionRecord, connector: SiteConnector): Promise<ProviderAdapter> {
    const profileDir =
      record.options.profile_dir ?? (await profilePath(this.options.dataDir, record.id));
    return new BrowserChatAdapter({
      connector,
      profileDir,
      mode: record.options.mode ?? "automatic",
      ...(record.options.channel ? { channel: String(record.options.channel) } : {}),
      ...(record.options.executable_path ? { executablePath: String(record.options.executable_path) } : {}),
      ...(record.options.brave_attach === true ? { attachToBrave: true } : {}),
      ...(record.options.prompt_tools === true ? { promptTools: true } : {}),
    });
  }
}

/**
 * Custom API routes start conservative. The owner may explicitly declare what their
 * server supports; fixed provider presets always keep their documentation-backed claims.
 */
function configuredCapabilities(
  preset: import("@ownai/adapters").ApiPreset["capabilities"],
  raw: unknown,
): import("@ownai/contracts").AdapterCapabilities {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return preset;
  const value = raw as Record<string, unknown>;
  return {
    ...preset,
    ...(typeof value.tools === "boolean" ? { tools: value.tools ? ("native" as const) : ("none" as const) } : {}),
    ...(typeof value.json_mode === "boolean" ? { json_mode: value.json_mode } : {}),
    ...(value.streaming === "buffered" || value.streaming === "native" ? { streaming: value.streaming } : {}),
    ...(Array.isArray(value.sampling_params) && value.sampling_params.every((item) => typeof item === "string")
      ? { sampling_params: value.sampling_params as string[] }
      : {}),
  };
}

async function profilePath(dataDir: string, id: string): Promise<string> {
  const dir = join(dataDir, "browser-profiles", id.replace(/[^a-z0-9_-]/gi, "_"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
