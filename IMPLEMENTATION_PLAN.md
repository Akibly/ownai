# Implementation Plan

Phases follow the master prompt numbering. The volume 06 phases (P0–P5) are shown in brackets where they differ.

## Permission gates (independent of engineering)

| Gate | Condition | Blocks |
|---|---|---|
| A-02 | Written provider permission to carry anyone other than the account owner through a consumer web surface | Third-party traffic on an A connector. Owner-only personal use on the owner's own machine is allowed by ADR-018 with `--i-am-the-account-owner`, and is labelled as an acknowledgement, not as permission |
| B-01 | The provider's own approval for this app to use its account-plan grant | Shipping the B connector; it stays disabled |
| B-02 | Written authorization from a consumer-plan provider | Any account-plan route for that provider |
| Relay | Independent cross-tenant review (06 §10) | Remote beta |

## Phase 0 — Analysis ✅
`DOCUMENTATION_ANALYSIS.md`, `REQUIREMENTS_TRACEABILITY.md`, `ARCHITECTURE_DECISIONS.md`, this file. Volume 04 outstanding.

## Phase 1 — Local bridge foundation ✅ [06 P1, weeks 2–3]
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

## Phase 2 — Dual browser mode ✅
Visible and automatic modes; login-recovery state machine (`signed_in → expired → awaiting_user → signed_in`); per-profile serialization; cancellation mid-generation; process cleanup on shutdown; profile deletion. Demo both modes against mock-chat.

**Shipped:** the three modes, the profile lock that makes "one session per profile" real, cancellation mid-generation, and adapter/window cleanup on a clean (SIGINT/SIGTERM) shutdown. Not shipped: `remove` leaves the profile directory in place, so deleting a session's profile is still a manual step. Live consumer sites are driven through the same engine; their reply selectors still need one verified turn per site on the owner's own account.

## Phase 3 — Real authorized integrations 🟡 [06 P2]
One OpenAI-compatible adapter with the presets listed by `pnpm bridge providers` — free-tier API endpoints and a local runtime on this machine, whose installed models come from its own `/v1/models` listing — is shipped and tested against a controlled server. Quota classification is still mapped from mocked 429s rather than tuned on a live provider; per-destination fallback consent works locally; the account-plan connector stays behind `policy_disabled` until that provider approves the specific app.

## Phase 4 — Desktop experience [06 P4 partial]
Tauri shell: Home, Connections, Models, Routing, Activity, Settings. Onboarding that explains A/B/C. Request tester; copyable snippets; diagnostics; Windows installer (signed when a certificate is available).

**Started:** `GET /console` (apps/bridge/src/console.ts) is the status page the bridge serves itself — connections, honest serving verdict, turns used against the daily budget, recent content-free requests, copyable client config. The gateway key appears masked, and its full value is fetched from `/console/key` only when Reveal is clicked. The read-only view of the store is separate from the action surface: enable/disable, a connection check, selector edits and the prompt-tools opt-in are POST/PATCH routes behind the same bearer key plus a same-origin gate, and a browser connection additionally needs an explicit confirmation because its check opens the site (it still sends no prompt and spends no turn). A request tester runs against the same `/v1/chat/completions` the clients use.
**Outstanding:** adding and removing connections stays CLI-only, the Tauri shell and installer are not built, and per-connection model selection in the console is limited to what `/v1/models` already lists.

## Phase 5 — Online dashboard and relay [06 P3]
Sign-in, device registry, pairing (code + device keypair + challenge), scoped gateway keys, relay with per-request owner checks, bounded frames, heartbeat, `device_offline`, revocation; usage metadata only.

## Phase 6 — MCP
`ask_model` and `list_models` tools that call the local HTTP API with a key; no direct adapter access.

## Phase 7 — Testing and beta
Security tests (origin, BOLA, secret canaries, update tamper), failure simulation, load, accessibility, fresh-install onboarding on Windows; 10–20 user private beta.

## Open items
- Volume 04 not yet supplied.
- D-04/D-05/D-06 are working defaults pending founder confirmation.
- Decide whether to send permission requests to the providers whose consumer surfaces are driven.
- One verified live turn per consumer site, on the owner's own account, before that site's reply selectors and the emulated tool round-trip can be called proven.
- `bridge remove` leaves the browser profile directory on disk; deleting a session is still a manual step.
