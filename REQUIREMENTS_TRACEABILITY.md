# Requirements Traceability

Maps each important requirement to its source, the component that implements it, and the test that proves it. **Status** reflects verified state, not intent.

Legend — Source: `01`…`06` = research volume and section; `MP` = master development prompt. Status: ✅ implemented and tested · 🟡 partial · ⏳ planned · ⛔ gated (blocked by permission).

Volume 04 was unavailable; no rows cite it.

| Req | Description | Source | Component | Test | Status |
|---|---|---|---|---|---|
| FR-01 | Normalized chat completion with source metadata | 02 §4; 03 §5 | `apps/bridge/src/routes/chat.ts`, `packages/contracts` | `chat.test.ts` T01 | ✅ Phase 1 |
| FR-02 | `/v1/models` reflects real connections only | 02 §4 | `apps/bridge/src/routes/models.ts` | `models.test.ts` | ✅ Phase 1 |
| FR-03 | Key required on loopback | 02 §4; 03 §3; 06 CORE-01 | `apps/bridge/src/security/auth.ts` | `auth.test.ts` T02 | ✅ Phase 1 |
| FR-04 | A adapter SDK + mock browser adapter E2E | 02 §4; 06 A-01 | `packages/adapters/src/browser/*`, `apps/mock-chat` | `browser-adapter.test.ts` | ✅ Phase 1 (background mode) |
| FR-05 | B account-plan adapter | 02 §4; 06 B-01 | `packages/adapters/src/openai-siwc` | contract suite | ⛔ awaiting OpenAI approval (D-02) |
| FR-06 | C: free API + Ollama | 02 §4; 06 C-01/C-02 | `packages/adapters/src/api/{openai-compat,presets}.ts` | `openai-compat.test.ts` | ✅ Phase 3: one OpenAI-compatible adapter + provider presets (OpenAI, xAI, DeepSeek, Qwen, Groq, Gemini, OpenRouter, Mistral, NVIDIA, Ollama, custom) |
| FR-07 | Quota/error normalization | 02 §4, §6 | `packages/contracts/src/errors.ts` | `errors.test.ts`, T05 | 🟡 Phase 1 enum + mapping; real provider 429 in Phase 3 |
| FR-08 | Streaming only where genuine | 02 §4; 03 §5 | `apps/bridge/src/routes/chat.ts` | `chat.test.ts` streaming cases | 🟡 Phase 1 (mock native stream; buffered label) |
| FR-09 | Device enrolment + last-seen | 02 §4 | `apps/dashboard` | relay suite | ⏳ Phase 5 |
| FR-10 | Remote relay opt-in | 02 §4; J02 | `apps/dashboard`, `apps/bridge/src/relay` | T10, T16 | ⏳ Phase 5 |
| FR-11 | Scoped gateway keys + revocation | 02 §4; 05 §3 | dashboard keys service | T13 | ⏳ Phase 5 |
| FR-12 | MCP facade via same policy | 02 §4; 06 MCP-01 | `packages/mcp` | MCP suite | ⏳ Phase 6 |
| FR-13 | Advanced tools/vision/JSON | 02 §4 | adapters | per-provider | 🟡 P2+: tools plumbed end-to-end for route C (`openai-compat.test.ts`); vision + JSON mode refused until a provider proves them (TRUTH-3) |
| FR-14 | Account deletion/export | 02 §4; 05 §6 | dashboard | — | ⏳ Phase 5 |
| FR-15 | Visible/background/automatic modes | MP §4 | `packages/adapters/src/browser/session.ts` | `browser-adapter.test.ts` | 🟡 Phase 1 background; Phase 2 visible/auto |
| FR-16 | Isolated profile per connection, one session per profile | 03 §8; MP §4 | `BrowserSessionManager` | `browser-adapter.test.ts` | 🟡 Phase 1 |
| FR-17 | No paid fallback; per-destination consent | 03 §6; 06 ROUTE-01 | `apps/bridge/src/router.ts` | `router.test.ts` T15 | ✅ Phase 1 |
| FR-18 | Request IDs, cancellation, timeouts | 03 §5, §9 | `apps/bridge/src/routes/chat.ts` | `chat.test.ts` | ✅ Phase 1 |
| FR-19 | Consumption label on responses | 02 §7 | `packages/contracts` `bridge.consumption` | `chat.test.ts` | ✅ Phase 1 |
| FR-20 | Connection lifecycle UI | 06 wk 3–5; J04 | loopback console `PATCH/POST /console/connections/:id`, `POST …/test` | `console-actions.test.ts` T24/T25/T27 | 🟡 enable/disable + a read-only provider check shipped (key + same-origin gated; route A needs an explicit confirm); selector tuning works for every browser site through `bridge inspect`/`bridge selectors`; a console selector editor is still pending |
| FR-21 | Connector kill switch | 03 §9; 05 §9 | `permission` field + router | `router.test.ts` T18 | 🟡 local flag Phase 1; remote switch Phase 5 |
| SEC-L1 | Loopback-only bind | 03 §3 | `apps/bridge/src/server.ts` | `server.test.ts` | ✅ Phase 1 |
| SEC-L2 | Host/Origin validation | 03 §3; 05 STRIDE | `security/origin.ts` | `auth.test.ts` T08 | ✅ Phase 1 |
| SEC-L3 | Body size limit, schema validation | 03 §3 | Fastify `bodyLimit`, Zod | `chat.test.ts` | ✅ Phase 1 |
| SEC-L4 | Secrets redacted in errors/logs | 05 §3; T14 | `security/redact.ts` | `redact.test.ts` T14 | ✅ Phase 1 |
| SEC-L5 | Secrets in OS keychain | 05 §3; 06 CORE-04 | `stores/secrets.ts` | `secrets.test.ts` | 🟡 Phase 1 (keyring + in-memory test double) |
| SEC-L6 | Bounded queue + concurrency caps | 03 §8 | `router` / `ConcurrencyGate` | `queue.test.ts` | ✅ Phase 1 |
| SEC-R1 | Owner check every remote request | 05 §4 | relay | T11 | ⏳ Phase 5 |
| SEC-R2 | Pairing replay resistance | 05 §4 | pairing | T12 | ⏳ Phase 5 |
| TRUTH-1 | No fabricated token counts | 03 §4; T17 | contracts `usage` optional | `chat.test.ts` T17 | ✅ Phase 1 |
| TRUTH-2 | Model confidence labelled | 02 §7; ADR-006 | `bridge.model_confidence` | `chat.test.ts` | ✅ Phase 1 |
| TRUTH-3 | Unsupported features rejected | 03 §5; T04 | chat route capability check | `chat.test.ts` T04 | ✅ Phase 1 |
| GATE-A | Written permission before live A connector | 06 A-02; 05 §8 | `permission.status` in connection record | `router.test.ts` T18 | ✅ enforced in code |

## Scripted end-to-end cases (06 §5)

| Case | Description | Phase | Test location |
|---|---|---|---|
| T01 | Valid local request | 1 | `apps/bridge/test/chat.test.ts` |
| T02 | Invalid API key | 1 | `apps/bridge/test/auth.test.ts` |
| T03 | Model unavailable | 1 | `apps/bridge/test/chat.test.ts` |
| T04 | Unsupported tool call | 1 | `apps/bridge/test/chat.test.ts` |
| T05 | Provider 429 | 1 (mock) / 3 (real) | `apps/bridge/test/router.test.ts` |
| T06 | Browser login expired | 1 | `packages/adapters/test/browser-adapter.test.ts` |
| T07 | Cancelled streaming client | 1 | `apps/bridge/test/chat.test.ts` |
| T08 | Unauthorized browser origin | 1 | `apps/bridge/test/auth.test.ts` |
| T09 | Cloud offline, local works | 5 | — |
| T10 | Remote device offline | 5 | — |
| T11 | Cross-account device ID | 5 | — |
| T12 | Pair-code replay | 5 | — |
| T13 | Revocation during stream | 5 | — |
| T14 | Secret canary in provider error | 1 | `apps/bridge/test/redact.test.ts` |
| T15 | Paid fallback denied | 1 | `apps/bridge/test/router.test.ts` |
| T16 | Remote relay privacy off | 5 | — |
| T17 | Unknown token count | 1 | `apps/bridge/test/chat.test.ts` |
| T18 | Provider permission flag disabled | 1 | `apps/bridge/test/router.test.ts` |
| T24 | Console enable/disable: same-origin accepted, cross-origin + no-key refused | 4 | `apps/bridge/test/console-actions.test.ts` |
| T25 | Console connection check: route A needs confirm, cross-origin + no-key + disabled refused | 4 | `apps/bridge/test/console-actions.test.ts` |
| T26 | Account site rules: composer sentinel refuses a turn that did not land, a challenge is handed back untouched, site wording maps to `quota_exhausted`, only this turn's reply is read, owner selectors replace a group | 21 | `packages/adapters/test/account-connectors.test.ts` |
| T27 | Read-only probe: consults the site without submitting, closes the window it opened, and separates signed-in / signed-out / challenge / browser-will-not-open | 5 | `packages/adapters/test/account-connectors.test.ts`, `apps/bridge/test/console-actions.test.ts` |
