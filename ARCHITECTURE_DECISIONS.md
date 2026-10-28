# Architecture Decisions

Each record states the decision, why, and what was rejected. ADR-001…006 come from volume 03 §10; later records are project decisions.

## ADR-001 — Local credential custody
**Decision:** Provider credentials, OAuth tokens, API keys and browser profiles live only on the user's device.
**Why:** Cloud-captured cookies would create a breach target and concentrate provider risk.
**Rejected:** Cloud-side session storage.

## ADR-002 — REST first, optional MCP wrapper
**Decision:** The OpenAI-style HTTP API is the primary contract. MCP (Phase 6) is a client of that API, not a separate path to adapters.
**Why:** Existing SDKs and tools already speak REST; MCP sampling was deprecated in the July 2026 spec.

## ADR-003 — Official routes are the reliable baseline
**Decision:** B and C routes are the production baseline. A connectors are gated on written provider permission.
**Why:** A browser bridge alone cannot guarantee permission or capability stability.

## ADR-004 — Opt-in relay without inbound ports
**Decision:** Remote access uses an outbound WSS tunnel from the device, off by default.
**Rejected:** Exposing the local HTTP server to the internet.

## ADR-005 — Keyed per-connection routing
**Decision:** Each model alias resolves to one concrete connection. Fallback only to destinations the user approved.
**Rejected:** Opaque "best available" routing, which can leak data or consume paid credits.

## ADR-006 — Preserve model uncertainty
**Decision:** Every response carries `model_confidence` = `verified` | `provider_declared` | `unknown`.
**Why:** Consumer UIs do not always disclose model provenance.

## ADR-007 — TypeScript monorepo with pnpm workspaces
**Decision:** `apps/*` and `packages/*` in one repo; strict TypeScript; Vitest.
**Why:** Shared contracts across bridge, dashboard and MCP; one toolchain.
**Rejected:** Separate repos (contract drift); Python bridge (weaker Playwright/Tauri sidecar story for this stack).

## ADR-008 — Fastify + Zod for the local API
**Decision:** Fastify 5 HTTP server; Zod 4 schemas in `packages/contracts` are the single source of truth for request/response shapes.
**Why:** Fastify provides `bodyLimit`, hooks for auth and `inject()` for fast tests. Zod gives runtime validation and static types from one definition.

## ADR-009 — Node built-in SQLite
**Decision:** Local config and metadata use `node:sqlite` (`DatabaseSync`).
**Why:** No native addon to compile for the bridge sidecar; synchronous API fits the small data volume.
**Rejected:** `better-sqlite3` (native build per platform).

## ADR-010 — OS keychain via `@napi-rs/keyring`
**Decision:** Secrets (local API key, provider API keys, OAuth refresh tokens) go to Windows Credential Manager / macOS Keychain / Secret Service. SQLite stores only a reference.
**Why:** `keytar` is archived; `@napi-rs/keyring` ships prebuilt binaries.
**Fallback:** an in-memory store for tests only, never used in production builds.

## ADR-011 — Local API key stored hashed, plaintext in keychain
**Decision:** The bridge verifies keys against a SHA-256 hash in SQLite (constant-time compare). The plaintext lives in the keychain so the desktop app can show it on demand. `bridge rotate-key` mints a replacement and deletes every older digest; because the digest is looked up per request, revocation takes effect on the next call with no restart.
**Why:** A copied SQLite file does not reveal a usable key.

## ADR-012 — Host allowlist and Origin rejection on loopback
**Decision:** Requests must carry `Host` of `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. Any request with a browser `Origin` header is rejected unless that origin is in an explicit allowlist (empty by default). No CORS headers are sent by default.
**Why:** Defeats DNS-rebinding and cross-site requests from web pages to localhost (05 STRIDE row 1).
**Consequence:** The status console (`GET /console`) is served without a gateway key, at the same trust level as `/health`: it renders metadata already in SQLite and offers no action. Its one read of a secret is the masked preview (the key's own `sk-ownai-` prefix, or `sk-local-` for one minted before the rename, plus bullets) in the markup; the full key is fetched from `GET /console/key` only when Reveal is clicked, so page source, history and any screenshot of the default view hold no credential. It stays inside the Host and Origin guards, and its CSP is `default-src 'none'; script-src 'self'; style-src 'self'` — one same-origin script, nothing inline, and no `style=""` attributes (they would be blocked silently, which a live click caught once).

## ADR-013 — Provider-login expiry returns 409, not 401
**Decision:** `login_required` maps to HTTP 409. 401 is reserved for an invalid *gateway* key.
**Why:** OpenAI SDKs treat 401 as "your API key is wrong", which would send users looking in the wrong place. Diverges from volume 02 §6 deliberately. Working default pending founder confirmation (D-06).

## ADR-014 — Browser engine: one site connector module per target
**Decision:** The browser engine (`BrowserChatAdapter`) owns profiles, modes, queueing, timeouts and normalization. A `SiteConnector` supplies only page-specific knowledge: URL, login detection, how to submit, how to detect completion, how to read the answer.
**Why:** A new authorized site is a small module, not a rewrite (03 acceptance checklist).
**Constraint:** Site connectors must not contain bot-detection evasion, CAPTCHA handling, fingerprint spoofing or rate-limit circumvention. Only the mock-chat connector exists. Connectors for sites without written permission are not built (D-07).

## ADR-015 — Browser execution modes
**Decision:** `visible` (headed window), `background` (headless, persistent isolated profile), `automatic` (background; on login or challenge, pause with `login_required` and ask the user to open visible mode).
**Why:** Master prompt §4. Automatic mode never attempts to complete a challenge itself.

## ADR-016 — Desktop shell: Tauri v2 with Node sidecar
**Decision:** Phase 4 packages the bridge as a Node sidecar inside a Tauri v2 shell (volume 03, S23).
**Why:** Smaller memory footprint and attack surface than Electron; Rust toolchain is present on the build machine.

## ADR-017 — Streaming honesty
**Decision:** If an adapter declares `streaming: "native"`, SSE chunks are forwarded as produced. If it declares `"buffered"`, the bridge sends one final chunk and sets `bridge.streaming = "buffered"`. If `"none"`, `stream:true` is rejected with `unsupported_feature`.

## ADR-018 — Personal-use route A, separated from provider permission
**Decision:** A `consumer_web` connection may serve traffic on one of two independent bases: written provider permission (`permission: approved`), or an explicit owner acknowledgement (`options.personal_use`) set only by the account owner running their own session on their own machine. The CLI requires `--i-am-the-account-owner` and refuses the record without it; removing that flag restores the original refusal. Serving a third party's traffic through such a connection stays gated on provider permission.
**Why:** The two questions are genuinely different. Provider permission governs offering this as a service; a person automating their own logged-in session accepts their own terms risk, and the account that gets limited is theirs. Collapsing them would have forced either a blanket refusal or a blanket opening.
**Rejected:** Dropping GATE-A entirely (that would open multi-user traffic); requiring `permission: not_required` for claude.ai (false). Guardrails kept regardless: no CAPTCHA handling, no fingerprint or UA spoofing, no proxy rotation, no multi-account pooling, no rate-limit circumvention; loopback-only, single-user, local daily cap and minimum turn spacing.
**Consequence:** `permission: denied` plus `personal_use: true` is a valid, labelled state, and `list` shows both so the distinction is never invisible. Route A remains unreachable from the relay.

## ADR-019 — OwnAI is a rename with migration, not a rewrite
**Decision:** The product is called OwnAI. Every layer that a person or another program touches carries the name: package identifiers (`@ownai/*`), the data directory (default `%LOCALAPPDATA%\OwnAI`, else `~/.ownai`), the OS credential service (`ownai`), the environment variables (`OWNAI_*`), and new gateway keys (`sk-ownai-`). Each old location is still honoured: on first run the CLI copies the pre-rename data directory forward, the secret store reads a legacy credential service and writes the value under `ownai`, and `BRIDGE_*` environment variables are accepted with a one-line notice naming their replacement.
**Why:** A rename that only changes strings leaves the owner's real state under the old names — a key they cannot find, a data directory the new build never reads. Migration has to run against the files and vault entries that exist on this machine, and the owner's existing credentials must survive it.
**Rejected:** Renaming display text only (orphaned data); requiring the owner to move anything by hand; deleting the source during migration. Copy, verify every file's size and readability, then leave the original in place and drop a `MIGRATED-TO-OWNAI.txt` marker naming the target.
**Consequence:** Existing gateway keys keep working, because authentication looks up the SHA-256 digest of the whole string and never parses its prefix (ADR-011) — a `sk-local-` key stays valid until it is rotated, and the console masks it with the label it actually carries. Because a legacy entry is copied forward on read, `delete()` removes the reference from the current *and* every legacy service name; otherwise a surviving old copy would resurrect a revoked key on the next read. Data migration is opt-in (`migrateDataDir`) and set only by the CLI, so a test injecting an in-memory store can never move the owner's live directory.

