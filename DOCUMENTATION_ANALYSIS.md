# Documentation Analysis

Status: Phase 0 output · Prepared 26 Oct 2026 · Covers research volumes 01, 02, 03, 05, 06.

> **Gap:** `04_provider_integrations.pdf` (Provider Integration Specifications) was not available when this analysis was written. Nothing below is drawn from it. Source markers S22, S25 and S30 never appear in the other five volumes and are probably defined in volume 04. When 04 is supplied, sections 2, 3 and 6 must be revisited.

---

## 1. Executive understanding

OwnAI — written up here under the name it had when this analysis was prepared, BYO AI Bridge — lets a person use AI access they already have — a provider account, a free API quota, or a model on their own machine — through one OpenAI-style local endpoint (`http://localhost:8791/v1/chat/completions`). It is aimed at people who cannot afford pay-as-you-go API billing.

The product never supplies, pools or resells accounts. Each response states which route answered, which allowance it consumed, and how certain the model identity is. When a quota runs out, the request fails clearly or moves only to a destination the user approved in advance.

Three routes feed the same contract:

| Route | Source of inference | Release condition |
|---|---|---|
| **A — consumer web session** | The user's own signed-in chat website, driven by a local browser adapter | Owner-only personal use on the owner's machine, recorded as an explicit acknowledgement (ADR-018); serving anyone else still needs written provider permission (gate A-02 / G0) |
| **B — official account grant** | A provider-sanctioned OAuth grant that lets an approved app use an existing plan | Eligibility + the provider's distribution conditions |
| **C — free API / local model** | User-owned free-tier API keys, or a model runtime on this machine | Documented terms; shippable now |

A is the central architectural objective. All five volumes agree it must be demonstrated against a mock or explicitly approved site and must not be publicly enabled for providers whose terms restrict automation. B and C make the product useful while A permission is pursued.

## 2. Document summaries

### 01 — Research & Feasibility
- **Thesis:** one OpenAI-style endpoint backed by access the developer already controls; no unlimited-generation promise.
- **Verdict:** transport, format translation, browser control and relay are technically achievable. The primary risk is *permission*, then UI fragility and user comprehension.
- **Provider landscape (as of Oct 2026, per S01–S09):** the consumer terms of the large assistant providers restrict automated access. At least one vendor offers a genuine API free tier. Ollama provides OpenAI-compatible local inference. One provider's **account-plan grant** scopes plan usage to eligible *local, open-source* apps via `/v1/responses` with `store:false`, `stream:true`, explicit context, and several tools excluded; paid or remotely hosted apps must apply for approval.
- **MCP:** the July 2026 spec deprecated sampling; do not borrow a client's model through MCP as the core engine (S14).
- **Competitors:** Universal Web API, WebAI-to-API, CLIProxyAPI (A-style, permission unproven), LiteLLM, OpenRouter, Ollama. Differentiation = onboarding, honest capability labels, local credential custody, explicit quota handling.
- **Feasibility table:** REST facade High; browser framework High *as a framework*; system prompts/tool calls via web Partial; B High where eligible; C High; dashboard High; relay High with effort; full API parity Low for A.
- **Four-way test for A:** can send / can reliably read / can normalize / can legally distribute / can maintain — never merged into one "works".
- **Stage gates:** G0 permission, G1 reliability, G2 value, G3 trust, G4 demand.
- **30-day evidence plan** (permission matrix, mock chat UI, 50-request benchmark, B+C+Ollama validation, interviews, 5-user pilot).

### 02 — Product Requirements
- **North star:** turn authorized access into a transparent API-like endpoint without gateway expertise.
- **Non-promises:** no unlimited prompts, no pooling, no full API parity for web routes, no offline-device service, no automatic paid spend.
- **Personas:** budget-limited individual (primary), indie developer, coding-agent power user, privacy-sensitive hobbyist; teams later.
- **Journeys:** J01 first local response (< 5 min target), J02 remote access via pairing, J03 quota exhausted, J04 revoke/disconnect.
- **Functional requirements FR-01…FR-14** (see §3).
- **Navigation:** local Home / Connections / Models / Routing / Activity / Settings; online Dashboard / Devices / Keys / Remote API / Usage / Account.
- **UX state table:** `ready`, `needs_login`→401 `login_required`, `quota_exhausted`→429, `unsupported_feature`→400, `provider_unavailable`→503, `policy_disabled`→403, `device_offline`→503, `remote_disabled`→403.
- **Design principles:** never obscure source; model confidence = verified / provider-declared / unknown; no cookie paste forms; colour never the sole state signal; keyboard reachable; consent next to the switch; explicit consumption label; safe defaults.
- **Metrics:** time-to-first-response, ≥95% local success, 100% accurate scripted errors, zero isolation failures, ≥90% comprehension.
- **Release gate per connection:** functional test + documented permission + capability truthfulness + credential isolation + rollback + user-facing limitation.
- **Out of scope v1:** mobile, team pooling, 24/7 hosted inference, account creation, limit circumvention, full compatibility, history sync, crawling, enterprise certifications.

### 03 — Technical Architecture
- **Shape:** API-first local execution; optional control plane and relay. Three planes: control, data, connector. MCP is a layer above the gateway.
- **Trust zones:** dev app → loopback → local daemon → router → A/B/C adapters; optional cloud edge → outbound WSS tunnel → daemon. The cloud holds no provider cookies or passwords.
- **Components:** desktop bridge, adapter runtime, router, local SQLite, OS keychain, cloud API, cloud Postgres, relay, observability.
- **Reference stack:** TypeScript/Node + Fastify, Playwright (approved connectors only), SQLite, Tauri or native installer, Next.js, Postgres, TLS WebSocket, optional Redis.
- **Local path:** bind 127.0.0.1/::1 only; auth on loopback; validate Origin/Host; JSON + size + modality validation; router resolves one concrete connection; token counts omitted unless measured.
- **Endpoints:** `/health`, `/v1/models`, `/v1/chat/completions`, `/v1/bridge/capabilities`; later `/v1/responses`; `/v1/bridge/connections` as local-admin scope.
- **Response extension:** `provider`, `connection_kind`, `model_confidence`, `local_or_remote`, `quota_status`.
- **Streaming:** ordered `chat.completion.chunk` + `[DONE]`; buffered single-chunk must be labeled not-realtime; cancel on disconnect; never auto-retry a non-idempotent generation after uncertain completion.
- **Router algorithm:** candidates = own enabled authorized connections → filter by permission gate & capabilities → quota/timeout/privacy/cost → preferred → fallback only to an explicitly approved *destination*. Consent is per source/destination class, not price class.
- **Relay:** pairing code + device keypair + proof of possession; frames `{version, request_id, device_id, expires_at, message_type, body}`; per-request owner check; bounded frames/queues; heartbeat; replay-resistant IDs; cancellation.
- **Data model & retention:** cloud users/devices/gateway_keys/request_events; local connections/routing_policies/request_events/browser profiles; 7-day local event default, no bodies.
- **Failure policy:** fail closed; bounded queue (e.g. 10); one concurrent UI session per browser profile; timeouts 20 s first byte / 120 s total.
- **ADR-001…006**; acceptance checklist (key always required, pairing tested, no secrets in cloud, offline 503, adapter addable without client/dashboard change, capabilities verified by tests).

### 05 — Security & Compliance
- **Top risk:** permission to turn consumer UI into a programmable service; then session protection and transport.
- **Assets:** provider session/OAuth/API keys, prompts and responses, device keys, gateway keys, consent/limits, cloud metadata, connector integrity.
- **Adversaries:** malicious websites, local malware, stolen laptop, leaked logs, phished dashboard user, malicious operator, compromised relay, other tenants, bad connector update, legitimate user attempting over-quota/cross-account routing.
- **STRIDE register** with mitigations and validations (localhost CSRF, stolen profile, cross-tenant BOLA, relay MITM, secrets in logs, paid fallback, malicious update, DoS, prompt in analytics, stolen device).
- **Credential custody:** provider-controlled login only; isolated profiles; keychain for keys/refresh tokens; content-free diagnostics; CSPRNG gateway keys shown once and stored salted-hashed; pairing key separate from provider credentials.
- **Remote authorization:** `gateway_key.owner_id == device.owner_id` + active pairing + consent + model aliases + spend cap + concurrency on every request; never trust a client-supplied device_id.
- **OAuth:** auth code + PKCE, system browser, loopback redirect (RFC 8252/9700), state/nonce, refresh rotation; never convert cookies into pseudo-tokens.
- **E2E claim:** forbidden unless real payload cryptography exists.
- **Retention defaults; data-subject controls; legal workstream** (GDPR/UK GDPR, India DPDP, US state laws).
- **Release gate record:** authorizing document, exact surface, purpose, redistribution rights, plan eligibility, quotas, regions, contact, next review date.
- **Incident runbook** and external-review checklist.

### 06 — MVP Execution
- **Thesis:** smallest tool proving connect → one endpoint → honest label → privacy-preserving fallback. A demonstrated against a mock.
- **Phases:** P0 legal/feasibility (wk 1), P1 local foundation (wk 2–3), P2 useful access (wk 3–5), P3 remote dashboard (wk 5–7), P4 private beta (wk 7–9), P5 real A connector (contingent, unscheduled).
- **Repo layout:** `apps/bridge`, `apps/dashboard`, `packages/contracts`, `packages/adapters`, `packages/mcp`.
- **Tickets:** CORE-01..04, A-01, A-02 (gate), C-01, C-02, ROUTE-01, B-01, WEB-01, RELAY-01/02, SEC-01, DOC-01, MCP-01.
- **Test cases T01–T18**; testing pyramid; SLO candidates (< 250 ms gateway P95 overhead; offline labelled within 60 s).
- **Founder decisions** and final go/no-go criteria; NO-GO on secret leak, cross-account execution, undetected paid fallback, CAPTCHA bypass, or "unlimited" claims.

## 3. Consolidated functional requirements

| ID | Requirement | Priority | Source |
|---|---|---|---|
| FR-01 | Normalized `/v1/chat/completions` text response with truthful source metadata | P0 | 02 §4, 03 §5 |
| FR-02 | `GET /v1/models` reflects actual connection capabilities; nothing unavailable advertised | P0 | 02 §4 |
| FR-03 | Local API key required even on loopback | P0 | 02 §4, 03 §3 |
| FR-04 | A adapter SDK with signed-in / degraded / denied states; mock browser adapter tested end-to-end | P0 | 02 §4, 06 A-01 |
| FR-05 | B adapter for approved account-plan inference, only for eligible users | P1 | 02 §4, 06 B-01 |
| FR-06 | C adapter: one free API + local Ollama; fallback explicitly configured | P0 | 02 §4, 06 C-01/C-02 |
| FR-07 | Quota and error normalization; quota distinguished from invalid credentials | P0 | 02 §4, §6 |
| FR-08 | Streaming only for truly streaming-capable adapters; terminal event required | P1 | 02 §4, 03 §5 |
| FR-09 | Dashboard device enrolment and truthful online/last-seen status | P1 | 02 §4 |
| FR-10 | Remote relay with explicit opt-in; cannot invoke disabled/offline device | P1 | 02 §4, J02 |
| FR-11 | Per-user/per-device scoped gateway keys; revocation within documented window | P1 | 02 §4 |
| FR-12 | MCP tool facade; `ask_model` uses same policy checks | P2 | 02 §4, 06 MCP-01 |
| FR-13 | Advanced tools/vision/JSON schema only after per-provider verification | P2+ | 02 §4 |
| FR-14 | Cloud account deletion and export | P1 | 02 §4 |
| FR-15 | Visible, background and automatic browser modes; automatic pauses for user interaction | P0 (master prompt) | Master prompt §4 |
| FR-16 | Isolated browser profile per connection; login-expiry detection; cancellation; one UI session per profile | P0 | 03 §8, master §4 |
| FR-17 | Router: no paid fallback, no pooling, per-destination fallback consent, route-change disclosure | P0 | 03 §6, 06 ROUTE-01 |
| FR-18 | Request IDs, cancellation, explicit timeouts (first-byte + total) | P0 | 03 §5, §9 |
| FR-19 | Consumption label on every response: plan allowance / free quota / local compute / paid | P0 | 02 §7 |
| FR-20 | Connection lifecycle: connect, test, pause, disconnect, delete local secret | P1 | 06 wk 3–5, J04 |
| FR-21 | Remote kill switch to disable a connector without deleting user data | P1 | 03 §9, 05 §9 |

## 4. Nonfunctional requirements

- **Security:** loopback-only bind; key on every generation call; Host/Origin validation; no unauthenticated CORS preflight success; request size limits; per-key concurrency; bounded queues; content-free logs; secret redaction in errors; keychain-backed secrets; signed releases and updates.
- **Privacy:** no prompt/response persistence by default; local event metadata 7 days; analytics opt-out; per-connector privacy notices; relay plaintext visibility disclosed; no E2E claim.
- **Truthfulness:** never fabricate model identity, token usage, tool support, context length, capabilities or reset times.
- **Performance:** gateway overhead P95 < 250 ms excluding provider time (target); 20 s first byte / 120 s total default timeouts.
- **Reliability:** fail closed; cloud outage does not affect local mode; no unbounded queues; no automatic retry after uncertain completion.
- **Maintainability:** new adapter without client SDK or dashboard schema change; adapters versioned behind health flags.
- **Accessibility:** keyboard reachable actions; errors announced; colour not sole indicator.
- **Platform:** Windows first (founder decision, 26 Oct 2026); macOS/Linux later.

## 5. Architecture and component dependencies

```
packages/contracts  ←  everything (schemas, error codes, capability model)
packages/adapters   ←  contracts            (adapter interface, mock, browser engine, C providers)
apps/bridge         ←  contracts, adapters  (server, auth, router, connection manager, stores)
apps/mock-chat      (standalone)            controlled A test target
apps/desktop        ←  bridge (sidecar)     Phase 4
apps/dashboard      ←  contracts            Phase 5 (relay talks to bridge over WSS)
packages/mcp        ←  bridge HTTP API      Phase 6 (no direct adapter access)
```

Critical-path dependencies: contracts → adapter interface → router → server. The browser engine depends on Playwright and the mock site. B depends on the provider's distribution approval. Relay depends on dashboard auth and device pairing.

## 6. Technical and legal feasibility

| Area | Technical | Permission / legal |
|---|---|---|
| Local REST facade | High | None required |
| A browser engine (framework) | High | None for mock/approved targets |
| A — consumer-site connectors | Possible but fragile; built for the owner's own session | Serving a third party is **not permitted** under consumer terms (S01, S02). Owner-only personal use is an explicit, labelled acknowledgement (ADR-018), never provider consent |
| B — a provider's account-plan grant | High where eligible | Docs (checked 26 Oct 2026) scope it to open-source, locally hosted apps; paid or remotely hosted apps must submit an interest form. The grant is unexercised: the B connector stays **disabled pending the provider's approval**. Free-plan eligibility is not stated |
| B — consumer plans of an assistant provider | No sanctioned route | Requires that provider's written authorization |
| C — free-tier API providers | High | Documented free tiers; per-route data-use notices |
| C — Ollama | High | None |
| Relay | High with effort | Privacy notice; regional data-law review |

## 7. Risks and mitigations

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| R1 | No major provider authorizes A | High / critical | Ship A as an engine + mock; pursue written permission; B/C deliver value |
| R2 | Stolen browser profile | Med / critical | Per-connection profile dirs under user profile, restrictive ACLs, never exported, delete on disconnect |
| R3 | Malicious web page calls localhost | High / high | Loopback bind, key on every call, Host allowlist, Origin rejection, no permissive CORS |
| R4 | Cross-tenant relay routing | Med / critical | Owner check per request; relay deferred until local is stable; BOLA tests |
| R5 | Secrets in logs/errors | Med / critical | Redaction layer, canary tests (T14), no body logging |
| R6 | Silent paid fallback | Low / high | Budget 0 default; per-destination consent; router hard cap; T15 |
| R7 | SDKs misread provider-login errors as bad key | High / medium | Return `login_required` as **409**, not 401 (decision D-06) |
| R8 | Time-sensitive facts drift (quotas, SIWC preview, MCP spec) | High / medium | Verify against official docs at adapter build time; record check date |
| R9 | Background mode mistaken for evasion | Med / high | Visible fallback only; no stealth plugins; activity indicator during background runs |
| R10 | Volume 04 content unknown | Certain / medium | Flagged; revisit when provided |
| R11 | An app that is not open-source is refused the account-plan grant | Certain / high | Largely lifted by the open-source release (D-02); the B connector still stays disabled until the provider approves the specific app, and its conditions are not satisfied by a license choice alone |

## 8. Founder decisions

| # | Question | Decision |
|---|---|---|
| D-01 | First OS | **Windows** (26 Oct 2026) |
| D-02 | License | **Proprietary for now** (26 Oct 2026), superseded: published **MIT OR AGPL-3.0-or-later** at the recipient's option for educational study (28 Oct 2026), with the terms in DISCLAIMER.md and the reasoning in ADR-022 |
| D-03 | Target users | **Anyone who cannot afford paid AI plans or API billing** (26 Oct 2026) |
| D-04 | Paid fallback in v1 | None — working default, awaiting founder confirmation |
| D-05 | Cloud relay in first public release | After local stability — working default, awaiting confirmation |
| D-06 | Status code for provider login expiry | 409 `login_required` — working default, awaiting confirmation |
| D-07 | Live consumer-site connectors | Built and used only against the owner's own signed-in session (ADR-018). Third-party traffic still needs the provider's written permission |
| Open | Pursue formal partnerships / written permission with the providers whose consumer surfaces are driven? | Pending |
| Open | First beta region (affects free-tier eligibility, privacy law) | Pending |
| Open | Supply volume 04 | Pending |

## 9. Proposed development sequence

1. **Phase 1:** contracts → adapter interface → mock adapter → router → local server with auth → stores → mock chat site → browser engine (background) → tests T01–T04, T08, T14, T17, T18.
2. **Phase 2:** visible + automatic modes, login-recovery state machine, queue/cancellation hardening, T06/T07.
3. **Phase 3:** local model runtime (C-01), free-tier API providers (C-02), quota classifier, fallback consent, the account-plan connector behind a disabled gate.
4. **Phase 4:** Tauri desktop shell, connection UI, request tester, Windows installer.
5. **Phase 5:** dashboard, pairing, gateway keys, relay; T10–T13, T16.
6. **Phase 6:** MCP facade through the HTTP gateway.
7. **Phase 7:** security, load, accessibility and fresh-install testing; private beta.
