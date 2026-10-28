import { CONSOLE_STYLE } from "./console-style.ts";
import { PLAYGROUND_JS } from "./console-playground.ts";
import { API_PRESETS, selectorGroupsForType, SELECTOR_GROUPS, type ApiPreset, type SelectorGroup } from "@ownai/adapters";
import {
  permissionAllowsTraffic,
  SCHEMA_VERSION,
  type ConnectionRecord,
} from "@ownai/contracts";
import type { BridgeStore } from "./stores/store.ts";
import { KEY_PREFIX, LEGACY_KEY_PREFIXES } from "./auth.ts";
import { DEFAULT_MAX_TURNS_PER_DAY, isPersonalUseWeb, permissionLabel, servesTraffic, startOfLocalDay } from "./policy.ts";

/**
 * The bridge's UI. It renders what is already in SQLite and offers a local action —
 * enable or disable a connection — which flips a flag and nothing else: it instantiates
 * no adapter, launches no browser, spends no turn and never touches a provider account.
 * That action is gated behind the gateway key, which only this same origin can read.
 * The request tester sends a real completion only after an explicit submission.
 * Opening the page itself still does none of that work. The gateway key is shown the way
 * other local tools show one: a masked preview in the markup, the full value fetched
 * from the credential store only when Reveal is clicked, and copy buttons that paste
 * the real key. Provider keys are posted only to the local route that writes them to
 * the OS credential store; they never enter the page source, database, or logs.
 */

export interface ConsoleInput {
  store: BridgeStore;
  /**
   * The request's Host, which the loopback guard has already pinned to a loopback
   * name. Used instead of a configured port so the address the page prints is the one
   * really serving, including when the OS picked the port.
   */
  host: string;
  version: string;
  /** Masked by the server. The full key is fetched only when Reveal is clicked. */
  keyPreview: string | null;
  keyRevealable: boolean;
  /** False for the disposable preview, whose in-memory secret store must not receive provider keys. */
  providerSetupEnabled?: boolean;
  now?: () => number;
}

interface EventRow {
  ts: string;
  connection_id: string;
  route: string;
  outcome: string;
  duration_ms: number;
}

export function renderConsole(input: ConsoleInput): string {
  const now = input.now?.() ?? Date.now();
  const connections = input.store.listConnections();
  const events = input.store.recentEvents(25) as EventRow[];
  const baseUrl = `http://${input.host}/v1`;
  // The mask doubles as the token the copy handler substitutes, so it must be the
  // exact string the page renders rather than something the script guesses.
  const mask = input.keyPreview ?? `${KEY_PREFIX}${"•".repeat(18)}`;
  const serving = connections.filter(servesTraffic);
  // The mock route sorts first by creation order but is nobody's real model, so a
  // snippet defaults to a provider-backed connection when one serves.
  const alias = (serving.find((c) => c.kind !== "mock") ?? serving[0] ?? connections[0])?.alias ?? "model";
  const canCopyKey = input.keyRevealable && input.keyPreview !== null;
  const snippets = snippetsFor(baseUrl, mask, alias);
  const providerPresets = Object.values(API_PRESETS).filter(
    (preset): preset is ApiPreset => Boolean(preset && preset.type !== "free_api:custom"),
  );
  const freePresets = providerPresets.filter((preset) => preset.consumption === "free_quota");
  const localPresets = providerPresets.filter((preset) => preset.consumption === "local_compute");
  const paidPresets = providerPresets.filter((preset) => preset.consumption === "paid_credits");
  const initialPreset = freePresets.find((preset) => preset.type === "free_api:groq") ?? freePresets[0] ?? localPresets[0]!;
  const providerId = (preset: (typeof providerPresets)[number]) => preset.type.slice(preset.type.indexOf(":") + 1);
  const providerOptions = (presets: typeof providerPresets) => presets.map((preset) => {
    const id = providerId(preset);
    const required = preset.requiresApiKey !== false;
    const price = preset.consumption === "free_quota" ? "Free quota" : preset.consumption === "local_compute" ? "Local" : "Paid API";
    return `<option value="${esc(id)}" data-model="${esc(preset.defaultModel)}" data-note="${esc(preset.note)}" data-key-required="${required}"${preset === initialPreset ? " selected" : ""}>${esc(preset.provider)} · ${price}</option>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>OwnAI</title>
<link rel="stylesheet" href="/console.css">
<script src="/console.js" defer></script>
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="topbar-inner">
<a class="brand" href="/console"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 16V8m16 8V8M4 12h16M8 8v8m8-8v8"/></svg></span>OwnAI</a>
<nav aria-label="Console"><a href="#connections">Connections</a><a href="#connect">Client setup</a><a href="#test">Try a request</a><a href="#activity">Activity</a></nav>
<span class="local-badge">Local access only</span>
</div></header>
<main id="main">
<div class="page-heading"><div><h1>Your AI, connected.</h1><p class="subtle">Manage your local connections and bring them to any OpenAI-compatible client.</p></div><a class="button" href="/console">Refresh status</a></div>
<div class="overview" aria-label="Connection summary">
<span><strong>${serving.length} of ${connections.length}</strong> connections enabled for requests</span>
<span><strong>${events.length}</strong> recent requests</span>
<span>Snapshot at <strong>${esc(localTime(new Date(now).toISOString()))}</strong></span>
</div>
<div class="workspace">
<section id="connections" aria-labelledby="connections-title">
<div class="section-heading"><div><h2 id="connections-title">Connections</h2><p class="subtle">Your models and their local usage limits.</p></div></div>
${connections.length === 0 ? '<div class="empty"><h3>No model connected yet</h3><p>Add a real provider API connection to route requests through OwnAI. Provider credentials are stored in your OS credential store.</p></div>' : `<div class="grid">${connections.map((c) => card(c, input.store, now)).join("")}</div>`}
<p class="hint">Status reflects local configuration. Provider login and availability are checked when you send a request.</p>
${input.providerSetupEnabled ? `<form id="provider-form" class="setup provider-setup" aria-labelledby="provider-form-title" method="post" action="/console/providers">
<h3 id="provider-form-title">Connect an API or local model</h3>
<p class="hint">This form connects provider APIs with a developer key, or a model running on this PC. For a personal consumer website session, use <code>pnpm bridge add-web-account &lt;chatgpt|grok|qwen|deepseek&gt; --i-am-the-account-owner</code>, then <code>pnpm bridge login &lt;id&gt;</code>. Claude uses <code>pnpm bridge add-claude --i-am-the-account-owner</code>. Sign in manually in the visible browser. Website and API quotas may differ.</p>
<div class="field"><label class="label" for="provider-select">Provider</label><select id="provider-select" name="provider" class="model-select">
${freePresets.length ? `<optgroup label="Free provider plans">${providerOptions(freePresets)}</optgroup>` : ""}
${localPresets.length ? `<optgroup label="Run on this PC">${providerOptions(localPresets)}</optgroup>` : ""}
${paidPresets.length ? `<optgroup label="Other provider APIs">${providerOptions(paidPresets)}</optgroup>` : ""}
</select><p id="provider-note" class="hint"></p></div>
<div class="provider-grid"><div class="field"><label class="label" for="provider-model">Model</label><div class="provider-model-control"><input id="provider-model" name="model" list="provider-model-options" maxlength="200" required value="${esc(initialPreset.defaultModel)}"><button id="provider-load-models" type="button">Load models</button></div><datalist id="provider-model-options"></datalist><p id="provider-model-status" class="hint">Load model IDs from this account, or enter one from the provider's dashboard.</p></div>
<div class="field"><label class="label" for="provider-alias">OwnAI model alias</label><input id="provider-alias" name="alias" maxlength="40" pattern="[a-z0-9][a-z0-9-]*" required value="${esc(providerId(initialPreset))}"></div></div>
<div id="provider-key-field" class="field"><label class="label" for="provider-key">Provider API key</label><input id="provider-key" name="api_key" type="password" maxlength="2048" autocomplete="new-password" spellcheck="false"><p class="hint">Paste the key from the provider here. It is sent only to this local OwnAI gateway, stored in Windows Credential Manager, and never shown again.</p></div>
<div class="row"><button id="provider-submit" class="primary" type="submit">Save connection</button><span id="provider-status" class="state" role="status" aria-live="polite"></span></div>
</form>` : '<div class="empty provider-setup"><h3>Provider setup is available in the regular OwnAI bridge</h3><p>This preview uses temporary in-memory state. Start <code>pnpm bridge start</code> to save provider connections and keys securely.</p></div>'}
<details class="guide"${connections.length === 0 ? " open" : ""}><summary>Add a connection</summary>
<ol><li>For a consumer website account, add a personal browser connection and sign in in the visible browser. The browser profile stays on this device.<code>pnpm bridge add-web-account qwen --alias qwen --i-am-the-account-owner</code><code>pnpm bridge login qwen-web</code></li>
<li>For a provider API, choose a supported provider and add its API connection. The provider key is entered locally and stored in your OS credential store.<code>pnpm bridge providers</code><code>pnpm bridge add-api &lt;provider&gt; --alias my-model</code></li>
<li>Start the gateway and use its printed address and gateway key in Compii Settings → Brain → OwnAI gateway.<code>pnpm bridge start</code></li></ol>
<p class="hint">Run these commands from the project folder, then refresh this page.</p></details>
</section>
<section id="connect" aria-labelledby="setup-title">
<div class="section-heading"><div><h2 id="setup-title">Connect a client</h2><p class="subtle">One local endpoint. Your choice of model.</p></div></div>
<div class="setup">
<div class="field"><span class="label">Base URL</span><div class="row"><code class="mono" id="baseurlline">${esc(baseUrl)}</code><button type="button" data-copy="#baseurlline" aria-label="Copy base URL">Copy</button><span class="state" role="status" aria-live="polite"></span></div></div>
<div class="field"><span class="label">Gateway API key</span><div class="row">
<code class="mono" id="keyline" data-mask="${esc(mask)}">${esc(maskLabel(input.keyPreview))}</code>
${canCopyKey ? '<button type="button" data-reveal aria-pressed="false">Reveal</button>' : ""}
<button type="button" data-copy="#keyline" aria-label="Copy API key"${canCopyKey ? "" : " disabled"}>Copy</button>
<span class="state" role="status" aria-live="polite"></span>
</div>${canCopyKey ? '<p class="hint">Copy includes the real key. Revealed keys hide when you leave this tab.</p>' : '<p class="hint">Key unavailable. Start the bridge with its credential store to enable copying.</p>'}</div>
<div class="field"><label class="label" for="model-select">Model alias</label>
<select id="model-select" class="model-select"${serving.length ? "" : " disabled"}>
${serving.length ? serving.map((c) => `<option value="${esc(c.alias)}" data-snippets="${esc(JSON.stringify(snippetsFor(baseUrl, mask, c.alias)))}"${c.alias === alias ? " selected" : ""}>${esc(c.alias)}${c.kind === "mock" ? " — local test model" : ""}</option>`).join("") : '<option>No enabled connections</option>'}</select></div>
<div class="code-header"><span class="subtle">Quick start</span><div class="tabs" role="tablist" aria-label="Code language">
${snippets.map((s, i) => `<button type="button" id="tab-${s.name}" role="tab" aria-controls="panel-${s.name}" aria-selected="${i === 0}" tabindex="${i === 0 ? "0" : "-1"}" data-tab="${s.name}">${s.name === "node" ? "Node.js" : s.name === "python" ? "Python" : "curl"}</button>`).join("")}</div></div>
${snippets.map((s, i) => `<div class="snippet-panel" id="panel-${s.name}" role="tabpanel" aria-labelledby="tab-${s.name}" tabindex="0"${i === 0 ? "" : " hidden"}><div class="row"><button type="button" data-copy-snippet="#${esc(s.id)}"${canCopyKey && serving.length ? "" : " disabled"}>Copy code</button><span class="state" role="status"></span></div>\n<pre class="snip" id="${esc(s.id)}">${esc(s.body)}</pre></div>`).join("\n")}
<p class="hint" id="snippet-hint">${serving.length ? "Sending this example uses one request on the selected connection." : "Enable a connection before sending a request."} Node.js and Python examples require the OpenAI SDK.</p>
</div></section></div>
<section id="test" aria-labelledby="test-title">
<div class="section-heading"><div><h2 id="test-title">Try a request</h2><p class="subtle">Check a connection here before adding it to your app.</p></div></div>
<form id="test-form" class="test-layout" data-available="${Boolean(canCopyKey && serving.length)}" aria-describedby="test-usage">
<div class="test-compose">
<label class="label" for="test-model">Connection</label><select id="test-model" class="model-select"${canCopyKey && serving.length ? "" : " disabled"}>
${serving.length ? serving.map((c) => `<option value="${esc(c.id)}" data-kind="${esc(c.kind)}"${c.id === (serving.find((r) => r.kind !== "mock") ?? serving[0])?.id ? " selected" : ""}>${esc(c.alias)} · ${esc(c.provider)}</option>`).join("") : '<option>No enabled connections</option>'}</select>
<p class="hint" id="test-usage">Select a connection to test.</p>
<label class="label" for="test-prompt">Your prompt</label><textarea id="test-prompt" rows="5" maxlength="12000" required placeholder="Ask a short question to check the connection…"${canCopyKey && serving.length ? "" : " disabled"}></textarea>
<div class="test-controls"><button id="test-send" class="primary" type="submit" disabled>Send request</button><button id="test-stop" type="button" hidden>Stop request</button><button id="test-clear" type="button">Clear</button></div>
<p class="hint">Ctrl / ⌘ + Enter to send. Each request starts a new conversation.</p>
</div>
<div class="test-output"><p id="test-status" class="test-status" role="status" aria-live="polite">Your response will appear here.</p>
<div id="test-result" hidden><div class="row"><strong>Response</strong><button type="button" data-copy="#test-response">Copy response</button><span class="state" role="status"></span></div><pre id="test-response"></pre><p id="test-meta" class="hint"></p></div>
<p class="hint">This console does not save prompts or replies. Clearing or reloading removes the response. The bridge stores only request metadata.</p><a href="/console#activity">Refresh activity</a></div>
</form></section>
<section id="activity" aria-labelledby="activity-title"><div class="section-heading"><div><h2 id="activity-title">Recent requests</h2><p class="subtle">The latest 25 requests. Metadata only; prompts and replies stay out of the log.</p></div></div>
${activity(events)}
</section>
<footer><p>Opening this page launches no browser and spends no turn. Only sending a request uses a connection.
Rotate your gateway key with <span class="mono">pnpm bridge rotate-key</span>.</p><p>v${esc(input.version)} · schema ${esc(SCHEMA_VERSION)}<br>loopback only, no remote exposure</p></footer>
</main></body></html>`;
}

function snippetsFor(baseUrl: string, mask: string, alias: string) {
  const model = JSON.stringify(alias);
  const payload = JSON.stringify({ model: alias, messages: [{ role: "user", content: "hello" }] });
  // Escape shell single quotes independently of HTML escaping.
  const shellPayload = payload.replace(/'/g, "'\\''");
  return [
    { id: "snippet-curl", name: "curl", body: `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${mask}" \\\n  -H "Content-Type: application/json" \\\n  -d '${shellPayload}'` },
    { id: "snippet-node", name: "node", body: `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${baseUrl}",\n  apiKey: "${mask}",\n});\nconst reply = await client.chat.completions.create({\n  model: ${model},\n  messages: [{ role: "user", content: "hello" }],\n});\nconsole.log(reply.choices[0].message.content);` },
    { id: "snippet-python", name: "python", body: `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${baseUrl}",\n    api_key="${mask}",\n)\nreply = client.chat.completions.create(\n    model=${model},\n    messages=[{"role": "user", "content": "hello"}],\n)\nprint(reply.choices[0].message.content)` },
  ];
}

const SELECTOR_LABELS: Record<SelectorGroup, string> = {
  composer: "Prompt box",
  assistant_message: "Assistant reply",
  stop_button: "Stop generating control",
  model_picker: "Model picker",
  challenge: "Verification challenge",
};

// Only overrides are editable; pre-filling defaults would freeze today's guesses on save.
function selectorEditor(record: ConnectionRecord): string {
  const defaults = selectorGroupsForType(record.type);
  if (!defaults) return "";
  const overrides = (record.options.selectors ?? {}) as Partial<Record<SelectorGroup, string[]>>;
  const prefix = `sel-${encodeURIComponent(record.id)}`;
  const rows = SELECTOR_GROUPS.map((group) => {
    const custom = overrides[group]?.length ? overrides[group] : undefined;
    const lines = (custom ?? []).join("\n");
    const hint = defaults[group].length > 0
      ? `Defaults: ${defaults[group].join(" · ")}`
      : "No site-specific defaults. Built-in challenge detection still applies.";
    return `<div class="selector-row"><label class="label" for="${prefix}-${group}">${esc(SELECTOR_LABELS[group])}</label>
<textarea id="${prefix}-${group}" rows="${Math.min(4, Math.max(2, lines.split("\n").length + 1))}" data-group="${group}" aria-describedby="${prefix}-help ${prefix}-${group}-hint" spellcheck="false" autocomplete="off">${esc(lines)}</textarea>
<p class="selector-mode" data-selector-mode>${custom ? "Custom override" : "Using defaults"}</p>
<p class="hint" id="${prefix}-${group}-hint">${esc(hint)}</p></div>`;
  }).join("");
  return `<details class="selector-editor"><summary>Selectors</summary>
<p class="hint" id="${prefix}-help">One selector per line, tried in order: up to 8 per group, 300 characters each. Leave a group blank and save to use its defaults. Saving opens no browser and sends no prompt. Saved selectors are not live-verified; inspect them with <code>pnpm bridge inspect ${esc(record.id)}</code></p>
<form class="selector-form" data-connection="${esc(record.id)}" aria-label="Selectors for ${esc(record.alias)}" method="post" action="/console/connections/${encodeURIComponent(record.id)}/selectors">
${rows}
<div class="row"><button type="submit" class="action">Save selectors</button><button type="reset">Undo edits</button><span class="state" role="status" aria-live="polite" aria-atomic="true"></span></div>
</form></details>`;
}

function card(record: ConnectionRecord, store: BridgeStore, now: number): string {
  const max = record.options.max_turns_per_day ?? DEFAULT_MAX_TURNS_PER_DAY;
  const used = store.countTurnsFor(record.id, startOfLocalDay(now));
  const budgeted = isPersonalUseWeb(record);

  const state = !record.enabled
    ? pill("disabled", "no")
    : !servesTraffic(record)
      ? pill("refused", "no")
      : permissionAllowsTraffic(record.permission)
        ? pill("serves traffic", "yes")
        : // The provider has not authorized this; the personal-use acknowledgement is
          // the only reason it serves. Saying "serves traffic" would contradict the
          // permission line two rows below it.
          pill("serves owner-only use", "warn");

  const browserRoute = record.type.startsWith("browser:");
  const promptTools = record.options.prompt_tools === true;

  return `<div class="card">
<div class="connection-heading"><h3>${esc(record.alias)}</h3><span class="pill">${record.kind === "mock" ? "Test model" : `Route ${esc(routeOf(record.kind))}`}</span></div>
<p class="provider">${esc(record.provider)}</p>
<div class="badges">${state}${browserRoute && promptTools ? ` ${pill("tools: prompt-mediated", "warn")}` : ""}${record.options.mode ? ` <span class="pill">browser ${esc(record.options.mode)}</span>` : ""}</div>
<div class="conn-actions">
<button type="button" class="action" data-action="${record.enabled ? "disable" : "enable"}" data-connection="${esc(record.id)}">${record.enabled ? "Disable" : "Enable"}</button>
<button type="button" class="action check" data-test data-connection="${esc(record.id)}">Check</button>
${browserRoute ? `<button type="button" class="action" data-tools data-on="${promptTools ? "true" : "false"}" data-connection="${esc(record.id)}">${promptTools ? "Stop offering tools" : "Offer tools"}</button>` : ""}
<span class="state" role="status" aria-live="polite"></span>
</div>
${record.kind === "mock" ? '<p class="hint">A local echo model for testing your client. No provider account or allowance is used.</p>' : ""}
${budgeted ? `<progress aria-label="Daily turns used for ${esc(record.alias)}" max="${max}" value="${Math.min(used, max)}"></progress>
<div class="budget">${used} of ${max} turns used today${used >= max ? " · Daily limit reached" : ""}</div>` : ""}
${selectorEditor(record)}
<details><summary>Connection details</summary>
<dl>
  <dt>connection ID</dt><dd class="mono">${esc(record.id)}</dd>
  <dt>provider</dt><dd>${esc(record.provider)}</dd>
  <dt>consumes</dt><dd>${esc(record.consumption)}</dd>
  <dt>permission</dt><dd>${esc(permissionLabel(record))}</dd>
  <dt>personal use</dt><dd>${record.options.personal_use === true ? "acknowledged owner-only" : "no"}</dd>
  <dt>pacing</dt><dd>${record.options.min_interval_ms != null ? `${Math.round(record.options.min_interval_ms / 1000)} s apart` : "—"}</dd>
  ${browserRoute ? `<dt>tool calls</dt><dd>${promptTools ? "prompt-mediated text protocol: one turn of the daily allowance per step" : "none — this page has no tool interface"}</dd>` : ""}
</dl></details>
</div>`;
}

function activity(events: EventRow[]): string {
  if (events.length === 0) return '<div class="empty"><h3>Your first request starts here</h3><p>No request has been served yet. Copy a quick-start example into your terminal or application, then refresh to see the result.</p><a class="button primary" href="#connect">Set up a client</a></div>';
  const rows = events
    .map(
      (e) =>
        `<tr data-outcome="${e.outcome === "ok" ? "ok" : "error"}"><td class="mono"><time datetime="${esc(e.ts)}" title="${esc(e.ts)}">${esc(localTime(e.ts))}</time></td><td class="mono">${esc(e.connection_id)}</td>` +
        `<td>${esc(e.route)}</td><td>${outcome(e.outcome)}</td><td class="mono">${e.duration_ms} ms</td></tr>`,
    )
    .join("");
  return `<div class="activity-tools"><div class="search"><label class="label" for="activity-search">Search requests</label><input id="activity-search" type="search" placeholder="Connection, route or outcome…"></div><div><label class="label" for="activity-filter">Outcome</label><select id="activity-filter"><option value="all">All outcomes</option><option value="ok">Successful</option><option value="error">Needs attention</option></select></div></div>
<div class="table-scroll" tabindex="0" role="region" aria-label="Recent request history"><table><thead><tr><th scope="col">Time, local</th><th scope="col">Connection</th><th scope="col">Route</th><th scope="col">Outcome</th><th scope="col">Duration</th></tr></thead><tbody>${rows}</tbody></table></div>
<p id="activity-empty" class="empty" hidden>No requests match these filters. Clear the search or choose all outcomes.</p>
<p id="activity-count" class="activity-count" role="status">Showing ${events.length} of ${events.length} recent requests</p>`;
}

/** Events are stored in UTC; the daily budget is measured from local midnight, so show local. */
function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour12: false });
}

function outcome(value: string): string {
  if (value === "ok") return pill("ok", "yes");
  if (value.startsWith("login")) return pill(esc(value), "warn");
  if (value === "rate_limited" || value.startsWith("quota")) return pill(esc(value), "warn");
  return pill(esc(value), "no");
}

function pill(text: string, kind: "yes" | "no" | "warn"): string {
  return `<span class="pill ${kind}">${text}</span>`;
}

function routeOf(kind: string): string {
  return { consumer_web: "A", account_grant: "B", free_api: "C", local_model: "C", mock: "test" }[kind] ?? "?";
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // An apostrophe has to survive as one: curl snippets are quoted with single
    // quotes, and mapping them to &quot; would hand the user a broken command.
    .replace(/'/g, "&#39;");
}

/** Kept beside the renderer so the stylesheet cannot drift from the markup. */
export const CONSOLE_CSS = `${CONSOLE_STYLE.trim()}`;

/**
 * Keeps the key's own prefix so the preview is recognisable as *this* key, which is
 * what every other local tool does. The prefix of a 256-bit random value is not a
 * meaningful head start on guessing it. A key minted under the old label keeps showing
 * the old label, because the preview describes the key the owner holds, not the build
 * that is rendering it.
 */
export function maskKey(key: string | null): string | null {
  if (!key) return null;
  const prefix = [KEY_PREFIX, ...LEGACY_KEY_PREFIXES].find((candidate) => key.startsWith(candidate));
  const head = (prefix ?? KEY_PREFIX).length + 3;
  return `${key.slice(0, head)}${"•".repeat(18)}`;
}

function maskLabel(preview: string | null): string {
  return preview ?? "no key yet — it is created by `pnpm bridge start`";
}

/**
 * Served as its own file so the CSP can stay script-src 'self' with nothing inline.
 * Credential reads, connection controls, and explicit request submission share the
 * same-origin authentication path. No request runs automatically on page load.
 */
export const CONSOLE_JS = `(function () {
  var keyline = document.getElementById("keyline");
  if (!keyline) return;
  var mask = keyline.getAttribute("data-mask");
  var hideTimer;
  var revealButton = document.querySelector("[data-reveal]");
  function hideKey() {
    if (!revealButton) return;
    clearTimeout(hideTimer);
    keyline.textContent = mask;
    revealButton.textContent = "Reveal";
    revealButton.setAttribute("aria-pressed", "false");
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) hideKey();
  });
  window.addEventListener("pagehide", hideKey);

  var tabs = Array.from(document.querySelectorAll("[data-tab]"));
  function selectTab(tab) {
    tabs.forEach(function (item) {
      var active = item === tab;
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !active;
    });
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { selectTab(tab); });
    tab.addEventListener("keydown", function (event) {
      var next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
  var modelSelect = document.getElementById("model-select");
  modelSelect.addEventListener("change", function () {
    var snippets = JSON.parse(modelSelect.selectedOptions[0].getAttribute("data-snippets"));
    snippets.forEach(function (snippet) { document.getElementById(snippet.id).textContent = snippet.body; });
    document.querySelectorAll(".snippet-panel .state").forEach(function (state) { state.textContent = ""; });
  });
  var search = document.getElementById("activity-search");
  var filter = document.getElementById("activity-filter");
  function filterActivity() {
    var rows = Array.from(document.querySelectorAll("tr[data-outcome]"));
    var term = search.value.trim().toLowerCase();
    var count = 0;
    rows.forEach(function (row) {
      var matches = row.textContent.toLowerCase().includes(term) &&
        (filter.value === "all" || row.getAttribute("data-outcome") === filter.value);
      row.hidden = !matches;
      if (matches) count++;
    });
    document.getElementById("activity-count").textContent = "Showing " + count + " of " + rows.length + " recent requests";
    document.getElementById("activity-empty").hidden = count !== 0;
  }
  if (search) {
    search.addEventListener("input", filterActivity);
    filter.addEventListener("change", filterActivity);
  }

  function say(button, text, bad) {
    var row = button.closest(".row");
    var box = row ? row.querySelector(".state") : null;
    if (!box) return;
    box.textContent = text;
    box.className = bad ? "state bad" : "state";
  }

  function write(text, button) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { say(button, "copied", false); },
        function () { legacyCopy(text, button); }
      );
      return;
    }
    legacyCopy(text, button);
  }

  // The async clipboard can still refuse (an embedded webview, a window without
  // focus), and a Copy button that does nothing is worse than an old API.
  // Positioning is a class, never el.style: style-src 'self' does not bless
  // anything written into a style attribute.
  function legacyCopy(text, button) {
    var box = document.createElement("textarea");
    box.className = "copybox";
    box.value = text;
    box.setAttribute("readonly", "");
    document.body.appendChild(box);
    box.select();
    var ok = false;
    try { ok = document.execCommand("copy") === true; } catch (err) { ok = false; }
    document.body.removeChild(box);
    say(button, ok ? "copied" : "select the value and press Ctrl-C", !ok);
  }

  function readKey(signal) {
    var timeout = AbortSignal.timeout(10000);
    return fetch("/console/key", { cache: "no-store", headers: { accept: "application/json" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (b) { throw new Error((b.error && b.error.message) || "no key"); });
        return r.json();
      })
      .then(function (body) {
        if (typeof body.key !== "string" || !body.key) throw new Error("Key unavailable. Refresh the console and try again.");
        return body.key;
      });
  }

  document.querySelectorAll(".selector-form").forEach(function (form) {
    var fields = Array.from(form.querySelectorAll("textarea[data-group]"));
    var controls = Array.from(form.querySelectorAll("textarea, button"));
    var status = form.querySelector(".state");
    var busy = false;
    function report(text, bad) {
      status.textContent = text;
      status.className = bad ? "state bad" : "state";
    }
    function lines(value) {
      return value.split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    }
    function validate(field) {
      var list = lines(field.value);
      var message = list.length > 8 ? "Use at most 8 selectors in this group." :
        list.some(function (line) { return line.length > 300; }) ? "Each selector must be 300 characters or fewer." : "";
      field.setCustomValidity(message);
      field.setAttribute("aria-invalid", String(Boolean(message)));
      return !message;
    }
    fields.forEach(function (field) {
      field.addEventListener("input", function () {
        validate(field);
        report("Unsaved changes. Save to apply them.", false);
      });
    });
    form.addEventListener("reset", function (event) {
      event.preventDefault();
      if (busy) return;
      fields.forEach(function (field) { field.value = field.defaultValue; validate(field); });
      report("Edits undone; saved selectors are unchanged.", false);
    });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (busy) return;
      var invalid = fields.filter(function (field) { return !validate(field); });
      if (invalid.length) { invalid[0].reportValidity(); return; }
      var groups = {};
      fields.forEach(function (field) {
        var list = lines(field.value);
        if (JSON.stringify(list) !== JSON.stringify(lines(field.defaultValue))) {
          groups[field.getAttribute("data-group")] = list;
        }
      });
      if (!Object.keys(groups).length) { report("No changes to save.", false); return; }
      busy = true;
      controls.forEach(function (control) { control.disabled = true; });
      form.setAttribute("aria-busy", "true");
      report("Saving selectors…", false);
      readKey().then(function (key) {
        return fetch("/console/connections/" + encodeURIComponent(form.getAttribute("data-connection")) + "/selectors", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + key },
          body: JSON.stringify({ groups: groups }),
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
      }).then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body && body.error && body.error.message || "Could not save selectors.");
          return body;
        });
      }).then(function (body) {
        fields.forEach(function (field) {
          var list = body.selectors[field.getAttribute("data-group")] || [];
          field.value = list.join("\\n");
          field.defaultValue = field.value;
          field.closest(".selector-row").querySelector("[data-selector-mode]").textContent = list.length ? "Custom override" : "Using defaults";
          validate(field);
        });
        report("Saved. Applies on the next request; no browser was opened.", false);
      }).catch(function (error) {
        report(error && error.message ? error.message : "Could not save selectors. Your edits are still here.", true);
      }).finally(function () {
        busy = false;
        controls.forEach(function (control) { control.disabled = false; });
        form.setAttribute("aria-busy", "false");
      });
    });
  });

  var providerForm = document.getElementById("provider-form");
  if (providerForm) {
    var providerSelect = document.getElementById("provider-select");
    var providerModel = document.getElementById("provider-model");
    var providerAlias = document.getElementById("provider-alias");
    var providerKey = document.getElementById("provider-key");
    var providerKeyField = document.getElementById("provider-key-field");
    var providerModelStatus = document.getElementById("provider-model-status");
    var providerModelOptions = document.getElementById("provider-model-options");
    var providerLoadModels = document.getElementById("provider-load-models");
    var providerStatus = document.getElementById("provider-status");
    var providerSubmit = document.getElementById("provider-submit");
    var providerAliasEdited = false;
    function selectedProvider() { return providerSelect.selectedOptions[0]; }
    function updateProviderForm() {
      var option = selectedProvider();
      providerModel.value = option.getAttribute("data-model") || "";
      document.getElementById("provider-note").textContent = option.getAttribute("data-note") || "";
      providerModelOptions.replaceChildren();
      providerModelStatus.textContent = "Load model IDs from this account, or enter one from the provider's dashboard.";
      var needsKey = option.getAttribute("data-key-required") === "true";
      providerKeyField.hidden = !needsKey;
      providerKey.required = needsKey;
      if (!providerAliasEdited) providerAlias.value = option.value;
    }
    providerSelect.addEventListener("change", function () {
      providerAliasEdited = false;
      providerKey.value = "";
      updateProviderForm();
    });
    providerAlias.addEventListener("input", function () { providerAliasEdited = true; });
    providerLoadModels.addEventListener("click", function () {
      providerLoadModels.disabled = true;
      providerModelStatus.textContent = "Checking the provider's model list…";
      providerModelStatus.className = "hint";
      readKey().then(function (gatewayKey) {
        return fetch("/console/providers/" + encodeURIComponent(providerSelect.value) + "/models", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", authorization: "Bearer " + gatewayKey },
          body: JSON.stringify({ api_key: providerKey.value }),
          signal: AbortSignal.timeout(12000),
        }).then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok) throw new Error(body && body.error && body.error.message || "Could not load model IDs.");
            return body;
          });
        });
      }).then(function (body) {
        providerModelOptions.replaceChildren();
        var models = Array.isArray(body.models) ? body.models.filter(function (model) { return typeof model === "string"; }) : [];
        models.forEach(function (model) {
          var option = document.createElement("option");
          option.value = model;
          providerModelOptions.appendChild(option);
        });
        providerModelStatus.textContent = models.length
          ? "Found " + models.length + " available model IDs. Select one from the field's suggestions."
          : "This provider did not return a model list. Enter a model ID from its dashboard.";
      }).catch(function (error) {
        providerModelStatus.textContent = error && error.message ? error.message : "Could not load model IDs.";
        providerModelStatus.className = "hint state bad";
      }).finally(function () { providerLoadModels.disabled = false; });
    });
    providerForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!providerForm.reportValidity()) return;
      providerSubmit.disabled = true;
      providerStatus.textContent = "Saving securely…";
      providerStatus.className = "state";
      readKey().then(function (gatewayKey) {
        return fetch("/console/providers", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", authorization: "Bearer " + gatewayKey },
          body: JSON.stringify({
            provider: providerSelect.value,
            model: providerModel.value.trim(),
            alias: providerAlias.value.trim(),
            api_key: providerKey.value,
          }),
          signal: AbortSignal.timeout(30000),
        }).then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok) throw new Error(body && body.error && body.error.message || "Could not save the provider connection.");
            return body;
          });
        });
      }).then(function (body) {
        providerKey.value = "";
        providerStatus.textContent = "Saved “" + body.connection.alias + "”. Refreshing connections…";
        setTimeout(function () { window.location.reload(); }, 500);
      }).catch(function (error) {
        providerStatus.textContent = error && error.message ? error.message : "Could not save this connection.";
        providerStatus.className = "state bad";
        providerSubmit.disabled = false;
      });
    });
    window.addEventListener("pagehide", function () { providerKey.value = ""; });
    updateProviderForm();
  }

  ${PLAYGROUND_JS}

  // Flip a connection's enabled flag. This
  // reads the gateway key (same origin only) to authorise the PATCH, then reloads so the
  // status reflects what SQLite now holds.
  function runAction(button) {
    var enable = button.getAttribute("data-action") === "enable";
    var id = button.getAttribute("data-connection");
    var card = button.closest(".card");
    var status = card ? card.querySelector(".conn-actions .state") : null;
    function say(text, bad) {
      if (status) { status.textContent = text; status.className = bad ? "state bad" : "state"; }
    }
    button.disabled = true;
    say(enable ? "Enabling…" : "Disabling…", false);
    readKey().then(function (key) {
      return fetch("/console/connections/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "content-type": "application/json", "authorization": "Bearer " + key },
        body: JSON.stringify({ enabled: enable }),
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (b) { throw new Error((b && b.error && b.error.message) || ("Request failed (" + r.status + ")")); });
      return r.json();
    }).then(function () {
      say("Done. Refreshing…", false);
      setTimeout(function () { window.location.reload(); }, 400);
    }).catch(function (err) {
      say(err && err.message ? err.message : "Could not update this connection.", true);
      button.disabled = false;
    });
  }

  // Offers or withdraws the text tool protocol for one browser connection. Turning it
  // on is confirmed because the cost is not this request but every turn it buys.
  function runTools(button) {
    var id = button.getAttribute("data-connection");
    var on = button.getAttribute("data-on") !== "true";
    var card = button.closest(".card");
    var status = card ? card.querySelector(".conn-actions .state") : null;
    function say(text, bad) {
      if (status) { status.textContent = text; status.className = bad ? "state bad" : "state"; }
    }
    if (on && !window.confirm(
      "This page has no tool interface, so your functions would be described in the prompt and the call read back" +
      " from the reply. Each step is a separate turn of the account's daily allowance and its own paced wait." +
      "\\n\\nOffer tools on this connection?"
    )) { say("Cancelled", false); return; }
    button.disabled = true;
    say(on ? "Turning on…" : "Turning off…", false);
    readKey().then(function (key) {
      return fetch("/console/connections/" + encodeURIComponent(id) + "/prompt-tools", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + key },
        body: JSON.stringify({ on: on }),
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (b) { throw new Error((b && b.error && b.error.message) || ("Request failed (" + r.status + ")")); });
      return r.json();
    }).then(function () {
      say("Done. Refreshing…", false);
      setTimeout(function () { window.location.reload(); }, 400);
    }).catch(function (err) {
      say(err && err.message ? err.message : "Could not change this setting.", true);
      button.disabled = false;
    });
  }

  // Runs the connection's health check: reachability and sign-in, no prompt, no turn.
  // A browser route first answers "requires_confirmation"; the native confirm is the
  // second explicit step before we open the provider site.
  function runTest(button) {
    var id = button.getAttribute("data-connection");
    var card = button.closest(".card");
    var status = card ? card.querySelector(".conn-actions .state") : null;
    function say(text, bad) {
      if (status) { status.textContent = text; status.className = bad ? "state bad" : "state"; }
    }
    function post(key, body) {
      return fetch("/console/connections/" + encodeURIComponent(id) + "/test", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + key },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(60000),
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (b) { throw new Error((b && b.error && b.error.message) || ("Check failed (" + r.status + ")")); });
        return r.json();
      });
    }
    button.disabled = true;
    say("Checking…", false);
    readKey().then(function (key) {
      return post(key, {}).then(function (first) {
        if (!first.requires_confirmation) return first;
        if (!window.confirm(first.warning || "This touches the live provider site. Continue?")) {
          button.disabled = false; say("Cancelled", false); return { cancelled: true };
        }
        say("Opening your browser…", false);
        return post(key, { confirm: true });
      });
    }).then(function (result) {
      if (!result || result.cancelled) return;
      if (result.ok) say("Reachable and signed in", false);
      else say((result.state || "not ready") + (result.detail ? ": " + result.detail : ""), true);
    }).catch(function (err) {
      say(err && err.message ? err.message : "Could not check this connection.", true);
    }).then(function () {
      button.disabled = false;
    });
  }

  // Anything that still carries the mask gets the real key substituted before it is
  // copied, so a pasted snippet is never a page full of bullets.
  function copyResolved(text, button) {
    if (text.indexOf(mask) === -1) { write(text, button); return; }
    button.disabled = true;
    say(button, "Reading key…", false);
    readKey().then(function (key) { write(text.split(mask).join(key), button); },
      function (err) { say(button, err.message + " Try refreshing the console.", true); })
      .finally(function () { button.disabled = false; });
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var button = target.closest("button");
    if (!button) return;

    if (button.hasAttribute("data-action")) { runAction(button); return; }
    if (button.hasAttribute("data-test")) { runTest(button); return; }
    if (button.hasAttribute("data-tools")) { runTools(button); return; }

    if (button.hasAttribute("data-reveal")) {
      if (button.getAttribute("aria-pressed") === "true") { hideKey(); say(button, "Key hidden", false); return; }
      button.disabled = true;
      say(button, "Reading key…", false);
      readKey().then(function (key) {
        if (document.hidden) return;
        keyline.textContent = key;
        button.textContent = "Hide";
        button.setAttribute("aria-pressed", "true");
        hideTimer = setTimeout(hideKey, 30000);
        say(button, "Hides automatically in 30 seconds", false);
      }, function (err) { say(button, err.message, true); })
        .finally(function () { button.disabled = false; });
      return;
    }
    var selector = button.getAttribute("data-copy");
    if (selector) {
      var element = document.querySelector(selector);
      if (element) copyResolved(selector === "#keyline" ? mask : element.textContent.trim(), button);
      return;
    }
    var snippet = button.getAttribute("data-copy-snippet");
    if (snippet) {
      var pre = document.querySelector(snippet);
      if (pre) copyResolved(pre.textContent, button);
    }
  });
})();
`;
