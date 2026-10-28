# Implementation Plan

Phases follow the master prompt numbering. The volume 06 phases (P0–P5) are shown in brackets where they differ.

## Permission gates (independent of engineering)

| Gate | Condition | Blocks |
|---|---|---|
| A-02 | Written provider permission for a consumer web surface | Any live A connector. None are built today. |
| B-01 | OpenAI approval for a proprietary app to use Sign in with ChatGPT plan usage (interest form) | Shipping the B connector; it stays disabled |
| B-Claude | Anthropic authorization for consumer-plan use | Any Claude consumer route |
| Relay | Independent cross-tenant review (06 §10) | Remote beta |

## Phase 0 — Analysis ✅
`DOCUMENTATION_ANALYSIS.md`, `REQUIREMENTS_TRACEABILITY.md`, `ARCHITECTURE_DECISIONS.md`, this file. Volume 04 outstanding.

## Phase 1 — Local bridge foundation [06 P1, weeks 2–3]
**Goal:** a client sends an OpenAI-style request and receives a normalized mock response; the browser engine drives a site we control.

| Work | Files |
|---|---|
| Workspace, strict TS, Vitest | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` |
| Contracts: chat request/response, SSE chunk, error codes, capabilities, bridge metadata | `packages/contracts/src/*` |
| Adapter interface, mock adapter | `packages/adapters/src/types.ts`, `mock.ts` |
| Browser engine + mock-chat site connector | `packages/adapters/src/browser/*` |
| Controlled test site | `apps/mock-chat/*` |
| Server, auth, Host/Origin guard, redaction, request IDs, cancellation | `apps/bridge/src/*` |
| Router with permission gate, capability filter, fallback consent, cost cap | `apps/bridge/src/router.ts` |
| Connection manager, SQLite store, keychain secrets | `apps/bridge/src/stores/*` |

**Tests:** T01–T08, T14, T15, T17, T18 plus unit suites.
**Exit:** curl and the OpenAI Node SDK succeed against the mock; invalid key, foreign origin and unsupported tool calls are rejected.

## Phase 2 — Dual browser mode
Visible and automatic modes; login-recovery state machine (`signed_in → expired → awaiting_user → signed_in`); per-profile serialization; cancellation mid-generation; process cleanup on shutdown; profile deletion. Demo both modes against mock-chat.

## Phase 3 — Real authorized integrations [06 P2]
Ollama (C-01) with installed-model discovery; Gemini free tier (C-02); Groq, OpenRouter free models, GitHub Models. Re-verify each provider's current docs before coding. Quota classifier from real 429/headers; per-destination fallback consent; B-01 implemented behind `policy_disabled` until OpenAI approval.

## Phase 4 — Desktop experience [06 P4 partial]
Tauri shell: Home, Connections, Models, Routing, Activity, Settings. Onboarding that explains A/B/C. Request tester; copyable snippets; diagnostics; Windows installer (signed when a certificate is available).

**Started:** `GET /console` (apps/bridge/src/console.ts) is a read-only status page served by the bridge itself — connections, honest serving verdict, turns used against the daily budget, recent content-free requests, copyable client config. The gateway key appears masked, and its full value is fetched from `/console/key` only when Reveal is clicked. It is store reads only: no adapter, no browser, no spent turn. Editing and lifecycle actions remain CLI-only, so FR-20 is still open.

## Phase 5 — Online dashboard and relay [06 P3]
Sign-in, device registry, pairing (code + device keypair + challenge), scoped gateway keys, relay with per-request owner checks, bounded frames, heartbeat, `device_offline`, revocation; usage metadata only.

## Phase 6 — MCP
`ask_model` and `list_models` tools that call the local HTTP API with a key; no direct adapter access.

## Phase 7 — Testing and beta
Security tests (origin, BOLA, secret canaries, update tamper), failure simulation, load, accessibility, fresh-install onboarding on Windows; 10–20 user private beta.

## Open items
- Volume 04 not yet supplied.
- D-04/D-05/D-06 are working defaults pending founder confirmation.
- Decide whether to send permission requests to OpenAI and Anthropic.
