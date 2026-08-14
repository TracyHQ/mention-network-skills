# Setting up collection routes — how to reach **full engine coverage**

Read this whenever the P1 probe shows an engine without working access, or a CLI that isn't logged
in yet. Every engine here ends up measured or the run moves to the backend lane — there is no
partial grid to fall back on (SKILL.md design contract 5).

Every route below is set up **once per machine** and reused by every later run.

## Every route here is a clean room

A route qualifies only if it runs **without a logged-in consumer chat account**. ChatGPT, Claude and
Gemini all personalize from saved memory, custom instructions and prior chats, so an answer read out
of the user's own browser measures *that account*, not the market the report claims to describe.
That is why `claude-in-chrome` is gone and why the model engines have no browser route at all — see
*Clean-room collection* in SKILL.md.

## The ranking

Offer routes in this order, per engine. A missing rank-1 route is a **setup offer**, not a reason to
drop to rank 2 — the setup is free and takes minutes on a plan the user probably already pays for.

| Rank | Route | Why it wins | Cells run |
|---|---|---|---|
| **1** | **Agent lane** — Claude Agent SDK, or a vendor agent CLI on an existing subscription | free, headless (no memory), no key to manage | in parallel — fastest |
| **2** | **API key** — provider key | metered for OpenAI; Gemini's free tier is genuinely free | in parallel |

`google_ai_mode` is ranked on its own — see its section below.

## Which route covers which engine

| Engine | 1 · Agent lane | 2 · API key |
|---|---|---|
| `chatgpt` | ✅ `codex` CLI (free, ChatGPT plan) | ✅ `OPENAI_API_KEY` (paid) |
| `claude` | ✅ Agent SDK, or the `claude` CLI (free, Claude plan) | — no Claude API route in the collectors |
| `gemini` | ✅ `gemini` CLI — **but on API-key auth**, see below | ✅ `GEMINI_API_KEY` (**free tier**) |
| `google_ai_mode` | ⛔ no model API exists | ⛔ — use `SERPAPI_API_KEY` (free 100/mo) or Playwright |

**The recipe that reaches 4/4** (~5–10 min setup, then reused forever): `codex` CLI logged in
(`chatgpt`) + Agent SDK or `claude` CLI logged in (`claude`) + `gemini` CLI on a free AI Studio key,
or that key straight through `collect-api.mjs` (`gemini`) + a free SerpApi key or the Playwright MCP
(`google_ai_mode`). Needs a ChatGPT plan and a Claude plan; everything else is free. Cells fan out →
the whole grid in a couple of minutes, at **zero marginal cost**.

Mixing is normal and encouraged: e.g. CLI for `chatgpt`/`claude`, a key for `gemini`, SerpApi for
`google_ai_mode`. The grid only requires every declared cell to be collected *somehow* — by a
clean-room route.

**If an engine has no access and the user won't set one up**, there is exactly one honest option:
the **backend lane**, which runs all four on the backend's own keys. A narrowed grid is not an
option — `INCOMPLETE_PLATFORM_GRID` rejects it after the quota is already spent.

---

## Clean room — every route has to earn it

A cell is supposed to record what a **neutral shopper in that market** sees. Every tool we collect
with was built for a developer working in their own repo, on their own machine, signed into their
own accounts — and each of those defaults, left alone, writes the operator into the measurement.
None of this throws. The cell still succeeds; only the number is wrong. So treat "is this route a
clean room?" as a setup step you verify, not a property you assume.

Five leak paths, all measured on real cells, with the switch that closes each:

| # | Leak | Who it hits | Close it with |
|---|---|---|---|
| 1 | `~/.claude/CLAUDE.md` — user-scoped, loads from **any** directory | `claude` CLI, Claude Agent SDK | `--setting-sources ''` · SDK: `settingSources: []` |
| 2 | `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` found by walking **up** from the cwd | every vendor CLI | run from an empty temp dir · codex also `-c project_doc_max_bytes=0` |
| 3 | The operator's **MCP server list**, narrated into the answer text | `claude` CLI | `--strict-mcp-config` (and pass no `--mcp-config`) |
| 4 | A **persistent browser profile** that keeps a login across runs | `playwright` MCP | `--isolated` · then assert *signed out* on the first page |
| 5 | The **machine's IP** standing in for the market | every browser/scrape route | pass the market explicitly: `hl=<lang>&gl=<country>` |

Three of these are not intuitive, so they are worth stating outright:

- **Omitting `settingSources` does not mean "load nothing."** On
  `@anthropic-ai/claude-agent-sdk@0.3.220` a bare `query()` still loaded the operator's global
  `CLAUDE.md`. The empty array has to be explicit.
- **A neutral cwd is not enough for `claude`.** It closes leak 2 only; `CLAUDE.md` is user-scoped
  and loads from anywhere, and MCP config travels its own path. All three switches, or none work.
- **The Playwright profile is not fresh.** It lives at `~/Library/Caches/ms-playwright-mcp/` and
  outlives the session, so "a fresh profile isn't logged in" — which this file used to claim — is
  false. One sign-in months ago is still a sign-in today.

`gemini` has **no** context-suppression flag as of CLI 0.52, so the empty cwd is its whole defence
and it cannot be fully verified. `--skip-trust` is required once you set `cwd`, because gemini
refuses to run in a directory the user never trusted and a temp dir never is.

**How to verify, rather than trust the flags.** Ask the model directly, in the same run, on the
same machine — a route that is clean will say so:

```bash
node "$HERE/scripts/collect-cli.mjs" --engine claude --prompt \
  "One line only: do you have any CLAUDE.md, AGENTS.md or project instructions loaded? \
   Quote 5 words if yes, otherwise write exactly: NO CONTEXT LOADED" --out /tmp/probe.json
```

Run it from **inside** the repo — that is the worst case, so a pass there is meaningful. Then read
the whole answer, not a grep: leak 3 surfaced as a trailing *"Note: two MCP servers … need
authorization"* that no keyword search would have been looking for.

Routes that sidestep the problem entirely, because there is no local state to inherit: **SerpApi**
(the request leaves SerpApi's servers, and `hl`/`gl` set the market) and **provider API keys**
(a plain HTTPS call — no profile, no config files).

## Rank 1 — the agent lane (free on an existing subscription)

### `codex` → covers `chatgpt`
```bash
npm i -g @openai/codex        # or: brew install codex
codex login                   # opens the browser → "Sign in with ChatGPT" (Plus/Pro/Team plan)
codex exec -c tools.web_search=true --skip-git-repo-check -s read-only "say ok"   # verify
```
- Cost: included in the ChatGPT plan. No `OPENAI_API_KEY` needed (and don't set one — it switches
  `codex` to metered billing).
- `login` is interactive: **ask the user to run it themselves** (in Claude Code: `! codex login`),
  don't try to drive the browser flow.

### `claude` → covers `claude`
```bash
npm i -g @anthropic-ai/claude-code
claude                        # then: /login → sign in with a Claude Pro/Max plan
claude -p "say ok" --allowedTools WebSearch                                        # verify
```
- Cost: included in the Claude plan. `collect-cli.mjs` unsets `ANTHROPIC_API_KEY` for the child so
  the subscription is used even if a metered key is exported.
- If you're already running inside Claude Code, the CLI is present — only the login may be missing.

### Claude Agent SDK → also covers `claude`

`@anthropic-ai/claude-agent-sdk` is frequently **not** installed, even inside Claude Code. It covers
only `claude`, which the `claude` CLI already covers on the same subscription with the same
`browser`/empty-`servedModel` cell shape. **Don't npm-install it mid-run to unblock a report** — fall
back to the CLI. Install it only if the user wants this route on purpose:

```bash
npm i @anthropic-ai/claude-agent-sdk       # inside the skill folder — see why below
node "$HERE/scripts/collect-agent-sdk.mjs" --prompt "say ok" --out /tmp/probe.json
```
Install it **local to the skill folder**, not `-g`. The collector reaches the SDK through a bare
`import '@anthropic-ai/claude-agent-sdk'`, and ESM resolves bare specifiers from the importing
file's own directory upward — it ignores `NODE_PATH` entirely (that variable only ever applied to
CommonJS `require`). So a global install plus `NODE_PATH="$(npm root -g)"` **does not work**: the
import throws and the collector reports the SDK as missing. If you must use a global install,
symlink it into place instead: `ln -s "$(npm root -g)" "$HERE/scripts/node_modules"`. Either way
`node_modules/` lands next to the bundle — keep it out of git and the `.tgz`.

### `gemini` → covers `gemini` (works, but **not** on the free OAuth tier)

```bash
npm i -g @google/gemini-cli
```

Then the auth step everyone gets wrong. Google retired the free "Code Assist for individuals" OAuth
tier: with `selectedType: "oauth-personal"` every call throws `IneligibleTierError` → *"migrate to
Antigravity"*, **even right after a successful `gemini` login** (re-measured 2026-07-28 on
gemini-cli 0.52.0 with fresh OAuth credentials). Logging in again does not fix it. Switch the CLI to
an API key instead:

1. Get a free AI Studio key: <https://aistudio.google.com/apikey> (no billing, no card).
2. Point the CLI at it — **editing `settings.json` is required**; exporting
   `GEMINI_DEFAULT_AUTH_TYPE` does *not* override a settings file that says `oauth-personal`
   (measured — it still threw):
   ```bash
   node -e "const f=require('os').homedir()+'/.gemini/settings.json',fs=require('fs');
   const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
   s.security={...s.security,auth:{...s.security?.auth,selectedType:'gemini-api-key'}};
   fs.mkdirSync(require('path').dirname(f),{recursive:true});
   fs.writeFileSync(f,JSON.stringify(s,null,2))"
   ```
   This preserves the user's existing `mcpServers` and other settings — don't overwrite the file.
3. Save the key so every later run finds it:
   ```bash
   GEMINI_API_KEY='<pasted>' node "$HERE/scripts/credentials.mjs" save GEMINI_API_KEY
   ```
4. Verify — note `--skip-trust`, without which a headless run aborts on an untrusted cwd:
   ```bash
   gemini --skip-trust -o text -p "say ok"
   ```

Cost: the AI Studio free-tier quota, same key `collect-api.mjs` would use. So this route is **not**
cheaper than the API route — it exists so all three model engines can share one uniform agent lane.
Expect the occasional `503` ("high demand"); the CLI retries with backoff on its own.

## Rank 2 — provider API key

### `GEMINI_API_KEY` → covers `gemini` (**free tier — get this one first**)
1. Open <https://aistudio.google.com/apikey> → *Create API key* (a Google account is enough; no
   billing, no card).
2. Save it for reuse (value from the env so it isn't echoed):
   ```bash
   GEMINI_API_KEY='<pasted>' node "$HERE/scripts/credentials.mjs" save GEMINI_API_KEY
   ```
3. Cost: free-tier quota (rate-limited, ample for one grid). Expect the occasional `503` — the
   collector retries with backoff.

### `OPENAI_API_KEY` → covers `chatgpt` (**paid**)
1. <https://platform.openai.com/api-keys> → *Create new secret key*. This is **billing-separate from
   a ChatGPT subscription**: it needs credit on the platform account, and the `web_search` tool bills
   per call on top of tokens.
2. `OPENAI_API_KEY='<pasted>' node "$HERE/scripts/credentials.mjs" save OPENAI_API_KEY`
3. Prefer the `codex` CLI if the user has a ChatGPT plan — same engine, no marginal cost. Reach for
   the key when there's no plan or the CLI can't be installed.

---

## `google_ai_mode` — its own ranking

It has **no model API at all**, so the ranking above never applies to it. Exactly **two** legal
routes — and unlike the chat UIs, both are account-free, which is why they are still allowed:

| Rank | Route | Setup | Cost |
|---|---|---|---|
| 1 | `serpapi` | key below | free tier ≈100 searches/month; server-side, parallel |
| 2 | `playwright` | `claude mcp add playwright -- npx -y @playwright/mcp@latest --isolated`, then **reload the session** so the tools appear | free; serial |

Prefer whichever already works — SerpApi leads when a key is stored because it needs no session
reload and its cells fan out.

On the Playwright route the profile must be **signed out of Google**, and that is not the default.
The MCP keeps a profile at `~/Library/Caches/ms-playwright-mcp/mcp-chrome-*` which **survives across
sessions** (verified 2026-07-28 against a 6-day-old profile), so one sign-in done at any point stays
signed in for every later run. Register with **`--isolated`** for a genuinely fresh profile per run
— that flag also clears the "Browser is already in use" failure when another instance holds the
shared profile. Then verify rather than assume: look for a *Sign in* affordance on the first page
you read and stop if it is absent. Never point the MCP at the user's real Chrome profile. A
signed-in AI Mode answer is personalized and the clean room is gone.

Never let an agent-lane or API-key choice stand in for this engine — the cell would simply be
missing and the submit fails with `MISSING_CELL`.

### `SERPAPI_API_KEY`
1. Sign up at <https://serpapi.com/users/sign_up> → key at <https://serpapi.com/manage-api-key>.
2. `SERPAPI_API_KEY='<pasted>' node "$HERE/scripts/credentials.mjs" save SERPAPI_API_KEY`
3. Cost: free plan ≈ **100 searches/month** — one search per `google_ai_mode` cell, so a normal grid
   costs 3–5 searches. Paid plans are per-search.

---

## After any setup step

1. **Re-probe, don't assume** — re-run the P1 preflight (`credentials.mjs status`, `command -v …`)
   and rebuild the coverage matrix from what actually answers.
2. **Save every new key** via `credentials.mjs save` so the next run asks for nothing.
3. **Re-state coverage** to the user ("now 4/4 engines") before spending anything on collection.
4. If a route still fails after two honest attempts, stop poking at it: offer the API-key route for
   that engine, or the backend lane — the user's call, not yours. Do **not** reach for a logged-in
   browser as the escape hatch (invisible bias), and do **not** offer to ship without the engine
   (rejected at submit).
