# OwnAI

One local, OpenAI-compatible endpoint for AI access you already have: your own free
consumer accounts, an API key with free quota, or a model running on this machine.

> **Educational project.** Published to study how a local gateway, provider adapters and
> browser automation fit together. Read [DISCLAIMER.md](DISCLAIMER.md) before you run a
> browser connection: automated access to a consumer site may breach that site's terms,
> and the risk is the account owner's. Not affiliated with, or endorsed by, any provider.

OwnAI listens on loopback only (`127.0.0.1`), speaks `/v1/chat/completions` and
`/v1/models`, and records nothing about what you ask beyond content-free request
metadata. It exists for people who cannot pay per-token billing, not to resell access.

## What it will not do

These are design decisions, not missing features:

- **It never types your password and never touches a challenge.** Sign-in happens in a
  visible browser window that you complete yourself; CAPTCHAs, "verify you are human"
  pages and account enforcement are handed back to you.
- **It never pretends.** A capability is declared `native`, `emulated`, or `none`.
  Browser replies are `buffered` until proven otherwise; tools on a chat page are
  `emulated` and say so in every response. Streamed bytes are labelled honestly.
- **It serves one person.** Browser connections carry `permission: denied` plus
  `personal_use: true`: that is a recorded acknowledgement that you are driving your
  own account on your own machine, not a grant of permission or an authorization to
  carry anyone else's traffic.

## Requirements

- Node.js **22.13+** (the bridge uses `node:sqlite`)
- pnpm 10
- Windows, macOS or Linux. Browser routes need Chromium (`pnpm browsers:install`) or a
  browser you already run.

```bash
pnpm install
pnpm browsers:install   # only for browser routes on an isolated profile
```

## Quick start

```bash
# 1. Start the gateway. It prints the gateway key once, on first run.
pnpm bridge start

# 2. Add a connection (three shapes; see "Routes" below).
pnpm bridge add-web-account <site>  --i-am-the-account-owner   # your own account (route A)
pnpm bridge add-api <provider>      # an API key from the provider   (route C)
#    or use a model on this machine:
#    pnpm bridge add-api custom --base-url http://127.0.0.1:11434/v1 --alias local

# 3. For a browser route, open the site and sign in yourself.
pnpm bridge login <connection-id>

# 4. Point any OpenAI client at it.
pnpm bridge curl <alias>       # a ready-made curl command for that alias
```

`add-web-account` takes the site ids printed by `pnpm bridge --help` — the consumer chat
sites that ship with a connector today. One site has its own command, `add-claude`,
because it carries a different permission record and plan declaration. `pnpm bridge
providers` lists the API providers for route C.

`pnpm bridge start` serves:

| Surface | URL | Notes |
| --- | --- | --- |
| API | `http://127.0.0.1:8791/v1` | Bearer gateway key required |
| Status console | `http://127.0.0.1:8791/console` | Read-only view without a key; actions ask for it |

Override the port with `--port <n>` or `OWNAI_PORT`; data lives in
`%LOCALAPPDATA%\OwnAI` (or `~/.ownai`), changeable with `--data-dir` /
`OWNAI_DATA_DIR`.

## Routes

| Route | Kind | What it is | What a turn costs |
| --- | --- | --- | --- |
| A | `consumer_web` | Drives your own signed-in session at a consumer chat site in a real browser | One turn of that account's own allowance, paced locally |
| B | `account_grant` | Official account-grant integrations | Per provider terms |
| C | `free_api` / `local_model` | A documented OpenAI-compatible API key, or a model on this machine | The provider's quota, or your own compute |
| test | `mock` | A local echo model for client testing | Nothing |

Route A is the flexible one and the fragile one: it reads page layout, so a site
redesign needs selector tuning (see [When a site changes](#when-a-site-changes)).
Routes B and C are the reliable baseline. A router refuses traffic for every consumer
route until the connection carries the owner's `--i-am-the-account-owner`
acknowledgement, and the recorded permission stays `denied`; see
[DISCLAIMER.md](DISCLAIMER.md) for what that means.

## Signing in

```bash
pnpm bridge login <connection-id> [--timeout-minutes 15]
```

A visible window opens on the provider's own site. Sign in there; OwnAI polls until a
real signed-in session appears, then reports it. Two details that matter:

- **A landing page is not a session.** Consumer chat sites routinely show a
  working-looking composer to visitors who are signed out. OwnAI treats a visible
  "Sign in / Log in / Sign up" control as signed out, so `login` will keep waiting and a
  turn will report `login_required` instead of submitting into the void.
- **The window is closed when it times out**, and nothing is signed in. Re-run the
  command when you are ready.

Browser connections have three modes: `visible` (a headed window, so you watch every
turn), `background` (headless, same isolated profile) and `automatic` — the default,
headless like background but stopping with `login_required` the moment the site wants a
human, instead of waiting on a window you cannot see. No mode attempts a check itself.

### Attaching to your own Brave (Windows)

`pnpm bridge attach-brave <id>` drives your existing Brave profile instead of an
isolated one, over the debugger port you enable at `brave://inspect/#remote-debugging`.
Brave asks you to approve each debug session, one click per connection.

That path is not always granted: on Brave 156 the handshake never completed even after
approving the prompt (`/json` answered 404 and the socket stayed silent). When that
happens, stop fighting it and use the other shape — a connection that launches *your*
installed Brave on *your* profile directly, which needs no debug port but does need
every Brave window closed before each turn, because Brave's singleton hands a second
launch to the running instance.

`pnpm bridge detach-brave <id>` returns a connection to its isolated OwnAI profile.

## Command reference

| Command | Purpose |
| --- | --- |
| `pnpm bridge start [--port n] [--data-dir dir]` | Run the gateway |
| `pnpm bridge add-claude --i-am-the-account-owner [--prompt-tools]` | Route-A connection for the site that declares a plan (separate permission record) |
| `pnpm bridge add-web-account <site> [--mode …]` | Route-A consumer connection; `pnpm bridge --help` prints the current site ids |
| `pnpm bridge add-api [provider] [--base-url …] [--alias …]` | Route-C connection; key goes to the OS keychain |
| `pnpm bridge providers` | Route-C presets and what each costs |
| `pnpm bridge login <id>` | Open the sign-in page for you |
| `pnpm bridge list` / `enable` / `disable` / `remove` | Inspect and manage connections |
| `pnpm bridge models` | Model ids clients can ask for |
| `pnpm bridge key` / `rotate-key` | Reveal the gateway key / mint a replacement and revoke old ones |
| `pnpm bridge curl <alias>` | Print a working curl for that alias |
| `pnpm bridge attach-brave` / `detach-brave <id>` | Use your own Brave profile, or stop |
| `pnpm bridge prompt-tools <id> <on\|off>` | Opt a browser connection into the text tool protocol |
| `pnpm bridge inspect <id>` | Read-only DOM report: which selectors are present, plus inventory |
| `pnpm bridge selectors <id> <group> <css…>` | Replace one selector group without a code edit |

## Using it from a client

```bash
curl http://127.0.0.1:8791/v1/chat/completions \
  -H "Authorization: Bearer <gateway key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<alias>","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8791/v1", api_key="<gateway key>")
print(client.chat.completions.create(
    model="<alias>",
    messages=[{"role": "user", "content": "hello"}],
).choices[0].message.content)
```

Ask for the model **alias**, not the provider's raw model id. `pnpm bridge models`
lists what each connection answers to (for example `<alias>/default` for a site that
chooses its own model, or `<alias>/<model-id>` for a preset that reports its list).

## Capability labels

Every response carries a `bridge` block besides the usual OpenAI fields:

| Field | Values | Meaning |
| --- | --- | --- |
| `streaming` | `native` / `buffered` | Whether chunks are real incremental output or one final chunk |
| `tools` | `native` / `emulated` / `none` | Whether tools are a provider interface, a text protocol, or unsupported |
| `model_confidence` | `verified` / `provider_declared` / `unknown` | How much the reported model name is worth |
| `usage_source` | `provider` / `unavailable` | Whether token counts came from the provider |

`GET /v1/bridge/capabilities?connection=<id>` returns the full set for one connection.

### Tools on a browser connection

A chat website has no tool interface. With `--prompt-tools` (or
`pnpm bridge prompt-tools <id> on`), OwnAI describes your functions in the prompt,
asks for a fenced `ownai_tool` block, and reads a call back out of the reply. It is
always reported as `emulated`, and it is always opt-in, because **each step is a
separate turn** of the account's own allowance: a task that chains five tools costs at
least ten turns and two and a half minutes of local pacing. `tool_choice` is limited to
`auto` or `none`; anything stronger is refused before a turn is spent. See
[COMPII.md](COMPII.md) for the client-specific walkthrough.

## Data and secrets

- **Gateway keys** live as SHA-256 digests in SQLite; the plaintext is shown once and
  stored in your OS credential store (Windows Credential Manager, macOS Keychain,
  libsecret). `pnpm bridge rotate-key` retires every other digest.
- **Provider API keys** go to the same credential store, never to SQLite or a file.
- **Browser profiles** are isolated per connection under the data directory. They hold
  whatever the site's own sign-in set; OwnAI never copies cookies between profiles.
- **Events** record one content-free row per request (route, outcome, duration, byte
  counts, whether a turn was spent) and are pruned after 7 days by default
  (`OWNAI_EVENT_RETENTION_DAYS`). Prompts and replies are never stored.

## Local limits

- Loopback binding plus a `Host` header guard: a request arriving with a non-local
  `Host` is refused, so a tunnel or DNS rebinding cannot expose the API.
- Requests carrying an `Origin` header are refused unless that origin is listed in
  `OWNAI_ALLOWED_ORIGINS` (empty by default). Browsers cannot silently call the bridge.
- Browser connections default to **100 turns per day** and a **15-second floor** between
  turns, counted per connection from the events table. Requests that fail before a
  prompt reaches the provider do not consume the daily allowance.
- `OWNAI_TOTAL_TIMEOUT_MS` (default 120 s) and `OWNAI_FIRST_BYTE_TIMEOUT_MS` (20 s)
  bound a generation; `OWNAI_BODY_LIMIT` bounds the request body.

## Environment variables

OwnAI reads these from the environment; there is no dotenv file. Set them in the shell
that starts the bridge (or with `--port` / `--data-dir` for the two that have flags).

| Variable | Default | Purpose |
| --- | --- | --- |
| `OWNAI_PORT` | `8791` | Loopback port |
| `OWNAI_DATA_DIR` | `%LOCALAPPDATA%\OwnAI` / `~/.ownai` | SQLite, browser profiles |
| `OWNAI_ALLOWED_ORIGINS` | *(empty)* | Comma-separated browser origins allowed to call the API |
| `OWNAI_BODY_LIMIT` | `1048576` | Max request body, bytes |
| `OWNAI_TOTAL_TIMEOUT_MS` | `120000` | Absolute deadline for one generation |
| `OWNAI_FIRST_BYTE_TIMEOUT_MS` | `20000` | Deadline for the first streamed byte |
| `OWNAI_EVENT_RETENTION_DAYS` | `7` | How long content-free request events are kept (`0` disables) |
| `OWNAI_LOG_REQUESTS` | *(off)* | `1` prints one content-free line per request |
| `OWNAI_DEBUG_BROWSER` | *(off)* | `1` prints browser phases and DOM inventory when a selector misses |
| `OWNAI_API_KEY` | *(unset)* | Default key source for the `custom` API preset; `--key-env` overrides it |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401 invalid_api_key` | Send the gateway key from `pnpm bridge key` as `Authorization: Bearer …` |
| `404 model_not_found` | Use the alias from `pnpm bridge models`, not the provider's raw id |
| `login_required` on a browser route | The profile is signed out, or the site asked for a human check. Run `pnpm bridge login <id>` and finish it yourself |
| `This connection cannot call tools` | Route A with prompt tools off. Read the cost, then `pnpm bridge prompt-tools <id> on` |
| `provider_unavailable` "could not be started" | The browser could not open; another window may own the profile, or Brave is mid-launch |
| `timeout` "No reply appeared" | The page never produced a matching reply element. Rerun with `OWNAI_DEBUG_BROWSER=1` and check the logged inventory, then tune selectors |
| The composer never receives the prompt | The page's composer is not the one the selector matched. Check `pnpm bridge inspect <id>` |
| A verification page appears | Only you can clear it, in your own browser. Nothing in OwnAI will try |

### When a site changes

```bash
OWNAI_DEBUG_BROWSER=1 pnpm bridge start   # one line per phase, DOM inventory on a miss
pnpm bridge inspect <connection-id>       # read-only: selectors present + inventory
pnpm bridge selectors <connection-id> composer 'textarea[aria-label*="Ask"]'
```

Selector overrides are stored per connection, take effect on the next request, and are
editable from the console's connection card as well.

## Development

```bash
pnpm typecheck
pnpm test                # unit + integration; no provider account is touched
pnpm mock-chat           # a controlled chat site for browser-route work
pnpm preview             # render the console to HTML for a quick look
```

The tests drive a fixture site that imitates only the shape the connectors read — a
composer, an assistant message that grows, a stop control — so the suite never signs in
anywhere or spends a real turn.

## Repository layout

```
apps/
  bridge/        CLI, Fastify server, SQLite stores, router, console
  mock-chat/     controlled chat site used by the tests
packages/
  contracts/     shared types, capability model, error codes, request schema
  adapters/      provider adapters: OpenAI-compatible API, browser connectors, mock
LICENSE          GNU AGPL-3.0-or-later
DISCLAIMER.md    purpose, limits of liability, your account risk, what the code refuses
```

## License, legal and purpose

- **License:** GNU AGPL-3.0-or-later — see [LICENSE](LICENSE). If you run a modified
  version and let other people interact with it over a network, section 13 obliges you to
  offer them the corresponding source.
- **Purpose:** educational and research use. Read
  [DISCLAIMER.md](DISCLAIMER.md) first, especially the parts about provider terms,
  account risk, and the single-operator assumption.
- **No affiliation:** the project is not affiliated with, authorized by, or endorsed by
  any provider whose site or API it can reach. Provider names appear only where a
  command argument, a host, or a selector has to name one.

## Further reading

- [DISCLAIMER.md](DISCLAIMER.md) — intended use, your risk, and the enforced refusals
- [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) — every ADR, including the
  tri-state capability model, prompt-mediated tools, and honest streaming labels
- [COMPII.md](COMPII.md) — wiring Compii to OwnAI, including tools and the failure modes
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — phases and open items
- [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md) — requirements mapped to
  tests and current status
