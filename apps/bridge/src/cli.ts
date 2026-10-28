#!/usr/bin/env -s node --experimental-strip-types
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { API_PRESETS, OpenAiCompatAdapter, presetKind, type ApiPreset } from "@ownai/adapters";
import { accountWebConnection, apiConnection, claudeConnection, mockChatConnection } from "./connections.ts";
import { providerKeyRef } from "./secrets.ts";
import { createRuntime } from "./runtime.ts";
import { envValue, legacyEnvNotice } from "./migrate.ts";
import { startBridge } from "./server.ts";
import { servesTraffic, startOfLocalDay, permissionLabel } from "./policy.ts";
import { BridgeError, type ConnectionRecord, type ConnectionType, type Consumption } from "@ownai/contracts";

/**
 * The operator's own tool. Everything it can do is local and visible: it creates
 * connections, prints the gateway key once, opens a sign-in window for a human to
 * finish, and starts a loopback server.
 */

const HELP = `OwnAI (loopback only)

  bridge start [--port 8791] [--data-dir <dir>]
      Start the OpenAI-compatible server on 127.0.0.1. Prints the gateway key once
      when it is created. Data goes in the OwnAI folder in your user profile unless
      --data-dir or OWNAI_DATA_DIR says otherwise.

  bridge add-claude [--id claude-web] [--alias claude] [--mode automatic]
                    [--plan free|pro|max] [--max-turns-per-day 100]
                    [--min-interval-seconds 15] --i-am-the-account-owner
      Add a route-A connection to your own claude.ai session. The owner flag is
      required and means exactly one thing: you are driving your own account, on
      your own machine, and you accept the provider terms consequences of automated
      access. Without it the router refuses to serve the connection. It grants no
      provider permission and authorizes no other user's traffic.

  bridge add-web-account <chatgpt|grok|qwen|deepseek> [--id <id>] [--alias <name>]
                    [--mode visible|automatic|background] --i-am-the-account-owner
      Add your own consumer web account as a personal, local browser connection. The
      provider's sign-in page opens visibly when you run bridge login <id>; enter your
      credentials there. Calls use the account's own limits, with local pacing enabled.

  bridge add-mock-chat <http-url> [--id mock-chat]
      Add the controlled test site as a browser target (used by the test suite).

  bridge providers
      List the route-C providers OwnAI knows how to reach and what each one costs.

  bridge add-api <provider> [--model <id>] [--alias <name>] [--id <connection-id>]
                    [--base-url <url>] [--consumption free_quota|paid_credits|local_compute]
                    [--key-env <VAR>] [--key-file <path>]
                    [custom: --supports-tools --native-streaming --json-mode
                     --sampling-params temperature,top_p,max_tokens,max_completion_tokens,stop]
      Add a connection to a provider's own OpenAI-compatible API using a key you got from
      that provider. The key is read from the environment variable its docs name, from
      --key-file, or typed at the prompt; it goes into your OS credential store and never
      into SQLite or a plain file. No website is driven and nothing is scraped: this is
      the route the provider issued the credential for. Custom hosts start with tools,
      JSON mode and native streaming disabled. Enable only documented capabilities.

  bridge login <id> [--timeout-minutes 5]
      Open the provider's own sign-in page in a visible window. The bridge never
      types a credential and never touches a challenge.

  bridge attach-brave <id>
      Attach one browser connection to Brave's default profile through its user-enabled
      loopback DevTools port. Brave may ask you to allow each incoming debug session.

  bridge detach-brave <id>
      Return this connection to its isolated OwnAI browser profile.

  bridge inspect <id>
      Open the site read-only and report which selectors are present, plus an
      inventory of composer/reply/control elements we did not guess at. It does not
      click, type or submit anything.

  bridge selectors <id> <group> <css...>
      Replace a selector group (composer, assistant_message, stop_button,
      model_picker, challenge) using the inspect report. No code edit needed; the
      adapter picks the change up on its next request.

  bridge list | enable <id> | disable <id> | remove <id>
  bridge models | key | curl <alias>

  bridge rotate-key
      Mint a replacement gateway key and revoke every older digest. Use it when a key
      has been printed somewhere you no longer trust. A running bridge notices on its
      next request; clients have to be re-pointed at the new key.
`;

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

if (command === "help" || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

const { values: flags, positionals } = parseArgs({
  args: argv.slice(1),
  allowPositionals: true,
  options: {
    port: { type: "string" },
    "data-dir": { type: "string" },
    id: { type: "string" },
    alias: { type: "string" },
    mode: { type: "string" },
    plan: { type: "string" },
    model: { type: "string" },
    channel: { type: "string" },
    "base-url": { type: "string" },
    consumption: { type: "string" },
    "key-env": { type: "string" },
    "key-file": { type: "string" },
    "supports-tools": { type: "boolean" },
    "native-streaming": { type: "boolean" },
    "json-mode": { type: "boolean" },
    "sampling-params": { type: "string" },
    "max-turns-per-day": { type: "string" },
    "min-interval-seconds": { type: "string" },
    "timeout-minutes": { type: "string" },
    "i-am-the-account-owner": { type: "boolean" },
  },
});

const runtime = createRuntime({
  ...(flags["data-dir"] ? { dataDir: flags["data-dir"] } : {}),
  ...(flags.port ? { port: Number(flags.port) } : {}),
  onNotice: (message) => console.log(message),
  migrateDataDir: true,
});

// Read after createRuntime, which is what touches the environment through loadConfig.
const envNotice = legacyEnvNotice();
if (envNotice) console.log(envNotice);

try {
  await run();
} finally {
  await runtime.close();
}

async function run(): Promise<void> {
  switch (command) {
    case "start":
      return start();
    case "add-claude":
      return addClaude();
    case "add-web-account":
      return addWebAccount();
    case "add-mock-chat":
      return addMockChat();
    case "providers":
      return providers();
    case "add-api":
      return addApi();
    case "login":
      return login();
    case "attach-brave":
      return attachBrave();
    case "detach-brave":
      return detachBrave();
    case "inspect":
      return inspect();
    case "selectors":
      return setSelectors();
    case "list":
      return list();
    case "enable":
      return setEnabled(true);
    case "disable":
      return setEnabled(false);
    case "remove":
      return remove();
    case "models":
      return models();
    case "key":
      return key();
    case "rotate-key":
      return rotateKey();
    case "curl":
      return curl();
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exit(2);
  }
}

async function start(): Promise<void> {
  const keyInfo = await runtime.ensureGatewayKey();
  const running = await startBridge({
    store: runtime.store,
    registry: runtime.registry,
    router: runtime.router,
    port: runtime.port,
    // The plaintext key must never appear in an error body even in our own logs.
    secrets: keyInfo.plaintext ? [keyInfo.plaintext] : [],
    revealGatewayKey: () => runtime.revealGatewayKey(),
    addApiConnection: addConsoleApiConnection,
    listApiModels: listConsoleApiModels,
  });
  console.log(`OwnAI listening on ${running.url}/v1 (loopback only, no remote exposure)`);
  if (keyInfo.created && keyInfo.plaintext) {
    console.log(`\nGateway key (shown once, stored in your OS credential store):\n  ${keyInfo.plaintext}`);
    console.log(`\nRecover it later with: pnpm bridge key`);
  }
  console.log(`\nConnections: ${runtime.store.listConnections().map((c) => `${c.alias} (${c.id})`).join(", ")}`);
  console.log(`Status page: ${running.url}/console (read-only, loopback, no key needed to view)`);
  console.log(`Example:     curl ${running.url}/v1/models -H "Authorization: Bearer <key>"`);

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  await running.close();
}

async function addConsoleApiConnection(input: {
  provider: string;
  model: string;
  alias: string;
  apiKey?: string;
}): Promise<{ id: string; alias: string; provider: string; model: string }> {
  const preset = findPreset(input.provider);
  if (!preset || preset.type === "free_api:custom") {
    throw new BridgeError("invalid_request", "Choose one of the listed provider APIs.", { param: "provider" });
  }
  if (runtime.store.listConnections().some((connection) => connection.id === input.alias || connection.alias === input.alias)) {
    throw new BridgeError("invalid_request", `An alias "${input.alias}" already exists. Choose another alias.`, { param: "alias" });
  }
  if (!preset.consumption) {
    throw new BridgeError("invalid_request", "This provider needs extra cost settings in the command line.", { param: "provider" });
  }
  const id = input.alias;
  const record = apiConnection({
    type: preset.type,
    provider: preset.provider,
    kind: presetKind(preset.type),
    consumption: preset.consumption,
    model: input.model,
    id,
    alias: input.alias,
    baseUrl: preset.baseUrl,
  });
  const secretRef = providerKeyRef(id);
  if (preset.requiresApiKey !== false) {
    if (!input.apiKey) {
      throw new BridgeError("invalid_request", `Enter an API key for ${preset.provider}.`, { param: "api_key" });
    }
    await runtime.secrets.set(secretRef, input.apiKey);
  }
  try {
    runtime.saveConnection(record);
  } catch (error) {
    if (preset.requiresApiKey !== false) await runtime.secrets.delete(secretRef).catch(() => {});
    throw error;
  }
  return { id, alias: record.alias, provider: record.provider, model: record.model };
}

async function listConsoleApiModels(input: { provider: string; apiKey?: string }): Promise<string[]> {
  const preset = findPreset(input.provider);
  if (!preset || preset.type === "free_api:custom") {
    throw new BridgeError("invalid_request", "Choose one of the listed provider APIs.", { param: "provider" });
  }
  if (preset.requiresApiKey !== false && !input.apiKey) {
    throw new BridgeError("invalid_request", `Enter an API key for ${preset.provider} to load its models.`, { param: "api_key" });
  }
  if (!preset.consumption || !preset.baseUrl) {
    throw new BridgeError("invalid_request", "This provider needs extra endpoint settings in the command line.", { param: "provider" });
  }
  const adapter = new OpenAiCompatAdapter({
    type: preset.type,
    provider: preset.provider,
    kind: presetKind(preset.type),
    consumption: preset.consumption,
    baseUrl: preset.baseUrl,
    capabilities: preset.capabilities,
    requiresApiKey: preset.requiresApiKey,
    modelsList: preset.modelsList,
    ...(preset.headers ? { headers: preset.headers } : {}),
    readApiKey: async () => input.apiKey ?? null,
  });
  try {
    const models = await adapter.listModels(AbortSignal.timeout(8000));
    return [...new Set(models.map((model) => model.id))].slice(0, 200);
  } finally {
    await adapter.close();
  }
}

function addClaude(): void {
  if (!flags["i-am-the-account-owner"]) {
    console.error(
      "Refused: --i-am-the-account-owner is required.\n\n" +
        "Automated access to claude.ai is prohibited by the provider's consumer terms. Adding this\n" +
        "connection is allowed only when you are the account owner, running it for your own use on\n" +
        "this machine, and accepting that the account may be limited or closed. It does not create a\n" +
        "service for anyone else: if another person's traffic goes through it, you need written\n" +
        "provider permission, and the router keeps refusing that without it.",
    );
    process.exit(1);
  }
  const record = claudeConnection({
    ...(flags.id ? { id: flags.id } : {}),
    ...(flags.alias ? { alias: flags.alias } : {}),
    ...(flags.mode ? { mode: flags.mode as "visible" | "background" | "automatic" } : {}),
    ...(flags.plan ? { plan: flags.plan as "free" | "pro" | "max" } : {}),
    ...(flags.channel ? { channel: flags.channel } : {}),
    ...(flags["max-turns-per-day"] ? { maxTurnsPerDay: Number(flags["max-turns-per-day"]) } : {}),
    ...(flags["min-interval-seconds"] ? { minIntervalMs: Number(flags["min-interval-seconds"]) * 1000 } : {}),
    personalUse: true,
  });
  runtime.saveConnection(record);
  console.log(`Added ${record.id} as alias "${record.alias}" in ${record.options.mode} mode.`);
  console.log(`Daily local limit ${record.options.max_turns_per_day} turns, minimum ${record.options.min_interval_ms} ms between turns.`);
  console.log(`Next: pnpm bridge login ${record.id}   (a visible window opens; you sign in)`);
}

function addWebAccount(): void {
  const provider = positionals[0]?.trim().toLowerCase();
  if (!provider || !["chatgpt", "grok", "qwen", "deepseek"].includes(provider)) {
    console.error("Usage: pnpm bridge add-web-account <chatgpt|grok|qwen|deepseek> --i-am-the-account-owner");
    process.exit(2);
  }
  if (!flags["i-am-the-account-owner"]) {
    console.error("Refused: --i-am-the-account-owner is required. This route is for your own account on this machine only.");
    process.exit(1);
  }
  const typedProvider = provider as "chatgpt" | "grok" | "qwen" | "deepseek";
  const id = flags.id ?? `${typedProvider}-web`;
  const alias = flags.alias ?? typedProvider;
  if (runtime.store.getConnection(id) || runtime.store.listConnections().some((connection) => connection.alias === alias)) {
    console.error(`A connection ID or alias already uses "${id}" / "${alias}". Pass a different --id and --alias.`);
    process.exit(1);
  }
  const mode = (flags.mode ?? "automatic") as "visible" | "automatic" | "background";
  if (!["visible", "automatic", "background"].includes(mode)) {
    console.error("--mode must be visible, automatic or background.");
    process.exit(2);
  }
  const record = accountWebConnection({
    provider: typedProvider,
    id,
    alias,
    mode,
    personalUse: true,
    ...(flags["max-turns-per-day"] ? { maxTurnsPerDay: Number(flags["max-turns-per-day"]) } : {}),
    ...(flags["min-interval-seconds"] ? { minIntervalMs: Number(flags["min-interval-seconds"]) * 1000 } : {}),
  });
  runtime.saveConnection(record);
  console.log(`Added ${record.id} as alias "${record.alias}" (route A, browser:${typedProvider}).`);
  console.log(`Daily local limit ${record.options.max_turns_per_day} turns; minimum interval ${record.options.min_interval_ms} ms.`);
  console.log(`Next: pnpm bridge login ${record.id} — a visible window opens for you to sign in.`);
  console.log(`After sign-in, use model "${record.alias}" at http://127.0.0.1:${runtime.port}/v1/chat/completions.`);
}

function addMockChat(): void {
  const url = positionals[0];
  if (!url) {
    console.error("Usage: pnpm bridge add-mock-chat http://127.0.0.1:8790");
    process.exit(2);
  }
  const record = mockChatConnection(url, flags.id ?? "mock-chat");
  runtime.saveConnection(record);
  console.log(`Added browser test target ${record.id} -> ${url}`);
}

/** Resolve what the owner typed to a preset: full type, name after the colon, or a trading alias. */
function findPreset(name: string): ApiPreset | undefined {
  const aliases: Record<string, string> = {
    grok: "xai",
    "x-ai": "xai",
    dashscope: "qwen",
    alibaba: "qwen",
  };
  const wanted = name.trim().toLowerCase();
  const slug = (type: string) => type.slice(type.indexOf(":") + 1);
  const target = aliases[wanted] ?? wanted;
  return Object.values(API_PRESETS).find((preset) => {
    if (!preset) return false;
    return preset.type.toLowerCase() === target || slug(preset.type).toLowerCase() === target;
  });
}

function providers(): void {
  console.log("Route C providers OwnAI reaches with a key you obtained from each one directly:\n");
  for (const preset of Object.values(API_PRESETS)) {
    if (!preset) continue;
    console.log(`${preset.type.slice(preset.type.indexOf(":") + 1).padEnd(11)} ${preset.provider}`);
    console.log(`  endpoint   ${preset.baseUrl || "(you must pass --base-url)"}`);
    console.log(`  key var    ${preset.keyEnv}${preset.requiresApiKey === false ? "  (not required)" : ""}`);
    console.log(`  default    ${preset.defaultModel}`);
    console.log(`  costs      ${preset.consumption ?? "(you state it with --consumption)"}`);
    console.log(`  ${preset.note}`);
    console.log("");
  }
  console.log("Add one with: pnpm bridge add-api <name> [--model <id>] [--alias <name>]");
  console.log("For your own claude.ai session (route A, driven in your browser, no API key) use: pnpm bridge add-claude");
}

async function addApi(): Promise<void> {
  const name = positionals[0];
  if (!name) {
    console.error('Usage: pnpm bridge add-api <provider> [--model <id>] [--alias <name>] [--id <connection-id>]');
    console.error("Run `pnpm bridge providers` to list the names.");
    process.exit(2);
  }
  const preset = findPreset(name);
  if (!preset) {
    console.error(`Unknown provider "${name}". Run "pnpm bridge providers" for the list.`);
    if (/claude|chatgpt/i.test(name)) {
      console.error("A consumer web account is route A, not route C: use `pnpm bridge add-claude --i-am-the-account-owner`.");
    }
    process.exit(1);
  }
  const id = flags.id ?? preset.type.slice(preset.type.indexOf(":") + 1);
  if (runtime.store.getConnection(id)) {
    console.error(`A connection "${id}" already exists. Pass --id to name this one differently, or remove it first.`);
    process.exit(1);
  }

  // An unnamed host and its cost are facts only the owner has, so custom refuses defaults.
  const baseUrl = flags["base-url"] ?? preset.baseUrl;
  if (!baseUrl) {
    console.error(`${preset.provider} needs --base-url <url>: OwnAI will not guess a host for an endpoint it has not read.`);
    process.exit(2);
  }
  const consumption = (flags.consumption as Consumption | undefined) ?? preset.consumption;
  if (!consumption) {
    console.error(`${preset.provider} needs --consumption <free_quota|paid_credits|local_compute>: only you know what this costs.`);
    process.exit(2);
  }
  const model = flags.model ?? preset.defaultModel;

  const capabilityFlags = Boolean(
    flags["supports-tools"] || flags["native-streaming"] || flags["json-mode"] || flags["sampling-params"],
  );
  if (capabilityFlags && preset.type !== "free_api:custom") {
    console.error("Capability flags apply only to custom endpoints. Built-in providers use their documented capabilities.");
    process.exit(2);
  }
  const samplingParams = flags["sampling-params"]
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const allowedSamplingParams = new Set(["temperature", "top_p", "max_tokens", "max_completion_tokens", "stop"]);
  const unknownParams = (samplingParams ?? []).filter((param) => !allowedSamplingParams.has(param));
  if (unknownParams.length > 0) {
    console.error(`Unsupported sampling parameter(s): ${unknownParams.join(", ")}. Allowed: ${[...allowedSamplingParams].join(", ")}.`);
    process.exit(2);
  }

  const record = apiConnection({
    type: preset.type as ConnectionType,
    provider: preset.provider,
    kind: presetKind(preset.type),
    consumption,
    model,
    id,
    ...(flags.alias ? { alias: flags.alias } : {}),
    baseUrl,
    ...(capabilityFlags
      ? {
          capabilities: {
            ...(flags["supports-tools"] ? { tools: true } : {}),
            ...(flags["native-streaming"] ? { streaming: "native" as const } : {}),
            ...(flags["json-mode"] ? { json_mode: true } : {}),
            ...(samplingParams ? { sampling_params: [...new Set(samplingParams)] } : {}),
          },
        }
      : {}),
  });

  if (preset.requiresApiKey !== false) {
    const key = await readProviderKey(preset);
    if (!key) {
      const varName = flags["key-env"] ?? preset.keyEnv;
      console.error(
        `No API key. Set ${varName} in your environment, pass --key-file <path>, or re-run in a terminal to paste it.`,
      );
      process.exit(1);
    }
    // Written straight to the OS credential store; it never enters SQLite, argv, or a log (ADR-010).
    await runtime.secrets.set(providerKeyRef(id), key);
  }

  runtime.saveConnection(record);
  console.log(`Added ${record.id} as alias "${record.alias}" (route C, ${record.type}).`);
  console.log(`  model   ${record.model}`);
  console.log(`  cost    ${record.consumption}`);
  if (preset.type === "free_api:custom") {
    console.log(`  tools   ${flags["supports-tools"] ? "enabled by explicit declaration" : "disabled"}`);
    console.log(`  stream  ${flags["native-streaming"] ? "native by explicit declaration" : "buffered"}`);
    if (flags["json-mode"]) console.log("  JSON    enabled by explicit declaration");
    if (samplingParams?.length) console.log(`  params  ${[...new Set(samplingParams)].join(", ")}`);
  }
  console.log(`  key     ${preset.requiresApiKey === false ? "not needed for this local server" : "stored in your OS credential store"}`);
  console.log(`  ${preset.note}`);
  console.log(`\nIt is live on the next request. Test it: pnpm bridge list  ·  pnpm bridge models`);
}

/**
 * The key comes from the provider's own env var, a --key-file, or a paste at the
 * prompt — in that order, so a shell history entry is the last resort, not the default.
 */
async function readProviderKey(preset: ApiPreset): Promise<string | null> {
  const file = flags["key-file"];
  if (file) {
    const value = readFileSync(file, "utf8").trim();
    return value === "" ? null : value;
  }
  const varName = flags["key-env"] ?? preset.keyEnv;
  const fromEnv = envValue(varName);
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Paste your ${preset.provider} API key. It goes into your OS credential store, never a file or database.`);
    const answer = await rl.question("> ");
    const value = answer.trim();
    return value === "" ? null : value;
  } finally {
    rl.close();
  }
}

async function login(): Promise<void> {
  const id = positionals[0];
  if (!id) {
    console.error("Usage: pnpm bridge login <connection-id>");
    process.exit(2);
  }
  const timeoutMs = Number(flags["timeout-minutes"] ?? 5) * 60_000;
  console.log("Opening a visible browser window. Sign in there; this tool never handles a verification challenge.");
  const record = runtime.store.getConnection(id);
  if (!record) {
    console.error(`No connection "${id}".`);
    process.exit(1);
  }
  await runtime.router.interactiveLogin(id, AbortSignal.timeout(timeoutMs));
  console.log(`Signed in for ${id}. Use "background" or "automatic" mode to keep the window closed.`);
}

async function attachBrave(): Promise<void> {
  const id = positionals[0];
  if (!id) return fail("Usage: pnpm bridge attach-brave <connection-id>");
  const record = runtime.store.getConnection(id);
  if (!record || record.kind !== "consumer_web" || !record.type.startsWith("browser:")) {
    return fail(`Connection "${id}" is not a browser account connection.`);
  }
  runtime.saveConnection({
    ...record,
    options: { ...record.options, brave_attach: true },
    updated_at: new Date().toISOString(),
  });
  console.log(`Configured ${id} to attach to your Brave profile. Restart the bridge to use the attachment.`);
  console.log("The bridge will create and close its own tab; your other Brave tabs remain under your control.");
}

function detachBrave(): void {
  const id = positionals[0];
  if (!id) return fail("Usage: pnpm bridge detach-brave <connection-id>");
  const record = runtime.store.getConnection(id);
  if (!record) return fail(`No connection "${id}".`);
  const { brave_attach: _discarded, ...options } = record.options;
  runtime.saveConnection({ ...record, options, updated_at: new Date().toISOString() });
  console.log(`${id} will use its isolated OwnAI browser profile after the bridge restarts.`);
}

async function inspect(): Promise<void> {
  const id = positionals[0];
  if (!id) {
    console.error("Usage: pnpm bridge inspect <connection-id>");
    process.exit(2);
  }
  const record = runtime.store.getConnection(id);
  if (!record) {
    console.error(`No connection "${id}".`);
    process.exit(1);
  }
  const { inspectClaude, isChallengeUrl, ACCOUNT_SITE_DEFINITIONS, accountSelectorGroups } = await import("@ownai/adapters");
  // Forced visible mode so the user can see the page being reported on. The profile
  // on disk is reused, so an existing sign-in still counts.
  const adapter = await runtime.registry.get({ ...record, options: { ...record.options, mode: "visible" } });
  const inspectable = adapter as unknown as { openInspectPage(): Promise<Parameters<typeof inspectClaude>[0]> };
  // Report each site's own candidates, not claude.ai's, so an empty group means
  // "this site needs a selector" rather than "Claude's CSS did not match here".
  const site = (ACCOUNT_SITE_DEFINITIONS as Record<string, typeof ACCOUNT_SITE_DEFINITIONS.grok | undefined>)[
    record.type.slice("browser:".length)
  ];
  const report = await inspectClaude(
    await inspectable.openInspectPage(),
    record.options.selectors as Parameters<typeof inspectClaude>[1],
    site ? accountSelectorGroups(site) : undefined,
  );
  console.log(JSON.stringify(report, null, 2));
  if (isChallengeUrl(report.url)) {
    console.error(
      "\nhuman_check: the site is showing a verification page, so there is nothing here to read or tune. " +
        "Open the site in your own browser and complete the check there; the bridge never solves one for you. " +
        "Give it a few minutes afterwards before sending another turn.",
    );
    process.exitCode = 1;
    return;
  }
  if (/\/(login|logout)(?:\/|$)/.test(new URL(report.url).pathname)) {
    console.error(`\nlogin_required: sign in with "pnpm bridge login ${id}" before changing selectors.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nGroups with an empty list are the ones needing a selector update.");
  console.log("For assistant_message, pick the text_candidates entry whose preview is the reply without page chrome.");
  console.log("An empty assistant_message on a fresh chat only means no reply exists yet — inspect again after a turn.");
  console.log(`Apply one with: pnpm bridge selectors ${id} <group> "<css>"`);
}

function setSelectors(): void {
  const [id, group, ...css] = positionals;
  const allowed = new Set(["composer", "assistant_message", "stop_button", "model_picker", "challenge"]);
  if (!id || !group || css.length === 0) {
    return fail('Usage: pnpm bridge selectors <id> <group> "<css>" ["<fallback-css>"]');
  }
  if (!allowed.has(group)) return fail(`Unknown group "${group}". One of: ${[...allowed].join(", ")}`);
  const record = runtime.store.getConnection(id);
  if (!record) return fail(`No connection "${id}".`);

  const selectors = { ...(record.options.selectors as Record<string, string[]> | undefined) };
  selectors[group] = css;
  runtime.saveConnection({ ...record, options: { ...record.options, selectors }, updated_at: new Date().toISOString() });
  console.log(`${id}: ${group} = ${css.join(" , ")}`);
  console.log("The adapter rebuilds on its next request; no restart or code edit needed.");
}

function list(): void {
  const records = runtime.store.listConnections();
  if (records.length === 0) return console.log("No connections.");
  for (const record of records) describe(record);
}

function describe(record: ConnectionRecord): void {
  const served = servesTraffic(record);
  const used = runtime.store.countEventsFor(record.id, startOfLocalDay(Date.now()));
  console.log(
    [
      `${record.alias}  (${record.id})`,
      `  provider    ${record.provider}`,
      `  route       ${record.kind === "consumer_web" ? "A" : record.kind === "mock" ? "test" : record.kind === "account_grant" ? "B" : "C"}  type ${record.type}`,
      `  consumption ${record.consumption}${record.options.plan_declared_by_owner ? " (declared by you, not the provider)" : ""}`,
      `  permission  ${record.permission} - ${permissionLabel(record)}`,
      `  personal    ${record.options.personal_use === true ? "acknowledged owner-only use" : "no"}`,
      ...(record.type.startsWith("browser:")
        ? [`  browser     ${record.options.brave_attach === true ? "attached to Brave's default profile" : "isolated OwnAI profile"}`]
        : []),
      `  serving     ${served ? "yes" : "no (router refuses this connection)"}`,
      `  mode        ${record.options.mode ?? "-"}`,
      `  limits      ${used} of ${record.options.max_turns_per_day ?? "-"} turns used today, ${record.options.min_interval_ms ?? "-"} ms apart`,
      `  fallbacks   ${record.fallback_ids.length ? record.fallback_ids.join(", ") : "none approved"}`,
    ].join("\n"),
  );
}

function setEnabled(enabled: boolean): void {
  const id = positionals[0];
  if (!id) return fail("Usage: pnpm bridge enable|disable <connection-id>");
  runtime.store.setConnectionEnabled(id, enabled);
  console.log(`${id} ${enabled ? "enabled" : "disabled"}.`);
}

function remove(): void {
  const id = positionals[0];
  if (!id) return fail("Usage: pnpm bridge remove <connection-id>");
  runtime.store.deleteConnection(id);
  console.log(`Removed ${id}. Its browser profile directory is left in place; delete it yourself if you want the session gone.`);
}

async function models(): Promise<void> {
  for (const entry of await runtime.router.listModels()) {
    console.log(`${entry.id}  ${entry.bridge.route} ${entry.bridge.availability} ${entry.bridge.consumption}`);
  }
}

async function key(): Promise<void> {
  const keys = runtime.store.listKeys();
  if (keys.length === 0) return console.log("No gateway key yet; it is created when the bridge starts.");
  for (const entry of keys) {
    const plaintext = await runtime.revealGatewayKey(entry.id);
    console.log(`${entry.id}  ${entry.label}  created ${entry.created_at}`);
    console.log(`  ${plaintext ?? "(not found in the OS credential store)"}`);
  }
}

async function rotateKey(): Promise<void> {
  if (runtime.store.listKeys().length === 0) {
    return console.log("No gateway key to rotate yet; the next `bridge start` creates one.");
  }
  const next = await runtime.rotateGatewayKey();
  console.log(`New gateway key (shown once, stored in your OS credential store):\n  ${next.plaintext}`);
  console.log(`\nRevoked: ${next.retired.join(", ")}`);
  if (next.unscrubbed.length > 0) {
    // Worth saying out loud: a leftover plaintext cannot authorise anything, because
    // requests are matched against the digest row that is already gone.
    console.log(`Note: retired plaintext still in the credential store for: ${next.unscrubbed.join(", ")}`);
    console.log("It cannot authorise anything, but clear it from Windows Credential Manager if you want it gone.");
  }
  console.log("\nRe-point your clients at the new key; a running bridge accepts it on the next request.");
}

function curl(): void {
  const alias = positionals[0];
  if (!alias) return fail("Usage: pnpm bridge curl <model-alias>");
  console.log(
    [
      `curl -s http://127.0.0.1:${runtime.port}/v1/chat/completions \\`,
      `  -H "Authorization: Bearer $(pnpm -s bridge key | tail -1 | tr -d ' ')" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model":"${alias}","messages":[{"role":"user","content":"hello"}]}'`,
    ].join("\n"),
  );
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
