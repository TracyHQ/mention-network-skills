---
name: create-visibility-report
description: Use to create an AI Visibility Report for a Shopify store, end to end. Probes everything first — the Mention Network MCP, stored credentials, which collection routes actually work, the storefront catalog, any recent run — then asks the user at most three times, each a click on pre-filled options: one confirm card (shop, product, market, language, route per AI engine, cells/time/cost), one prompt approval, one optional website audit. Accepts a one-line shorthand in several shapes — `cli(chatgpt, claude, gemini) serpapi(google-ai-mode)`, the inverse `chatgpt=cli google_ai_mode=playwright`, or the group form `/create-visibility-report byok kbeautyarabia.com llm=cli ai-mode=playwright` where `llm` covers the three model engines — with every token order-free, misspellings corrected silently, and impossible route/engine pairs repaired instead of rejected. The three model engines (chatgpt / claude / gemini) are collected on the agent lane — the user's own CLI subscriptions — with API keys as the fallback; google_ai_mode has exactly two routes, Playwright or SerpApi. A logged-in consumer chat UI is never used: its memory and custom instructions personalize the answer and the report would no longer measure what a neutral shopper sees. Collects, analyzes the answers client-side by default (the backend then spends nothing and the report is ready on the first poll), validates, submits, exports the PDF, and hands back the link.
requires-mcp: [mention-network]
---

# Create Visibility Report

Produce an AI Visibility Report for a Shopify store. Two lanes: **BYOK** (default — the user's own
subscriptions/keys collect the answers) and **backend-run** (the backend spends its own AI budget).

**Design contract for this skill — hold to it:**

1. **Probe before you ask.** P1 runs unattended and fills every later option with a real value.
2. **Three asking moments, no more:** Q1 confirm → Q2 prompts → Q3 audit. Each is one
   `AskUserQuestion` with concrete pre-filled options; typing is the fallback, not the path.
3. **The confirm card always shows** — even when the shorthand supplied everything. Only the `yes`
   flag skips it.
4. **A gap is a setup task, not a verdict.** Never end a turn with "only 1 of 4 engines is possible"
   as if that settled it.
5. **The grid is all 4 engines × every declared intent — there is no partial BYOK run.** The backend
   rejects a short submission (`INCOMPLETE_PLATFORM_GRID` / `INCOMPLETE_INTENT_GRID`), so "drop the
   engine we can't reach" is not a lighter option, it is a run that spends the full quota and then
   fails. Missing access is fixed (log in / add a key) or the run moves to the backend lane.

```
P0 parse → P1 preflight → P2 resolve → [Q1 confirm] → P3 prompts → [Q2 approve]
        → P4 collect → P4.5 analyze → P5 validate → P6 submit+poll → P7 export → [Q3 audit]
```

Companion files — read the one the situation calls for, not all of them up front:

| File | Read it when |
|---|---|
| **`ARGUMENTS.md`** | The invocation carries arguments — grammar, aliases, route ranking, repair rules |
| **`SETUP-ROUTES.md`** | A route is missing and needs installing/keying/logging in |
| **`RECOVERY.md`** | Anything fails, or the invocation says `resume` — error → fix, run dir, resume |
| **`ANALYSIS.md`** | You've reached P4.5 (right after collection) — the full client-side detection playbook |
| **`COLLECT-PLAYWRIGHT.md`** | The chosen `google_ai_mode` route is `playwright`, not `serpapi` — driving the browser |

> A BYOK run's report carries `source: byok` — the numbers rest on data the submitter supplied and
> the backend never observed. **Disclose that wherever the report is shown to anyone else.**

## Clean-room collection — never a logged-in chat UI

The report answers one question: **what does a real shopper, with no history, see when they ask?**
A logged-in consumer chat UI cannot answer it. ChatGPT, Claude and Gemini all personalize from
saved memory, custom instructions and prior chats in that account — so the same prompt in the
user's own browser returns *their* answer, not the market's. Measured: this is what pushed the
`claude-in-chrome` route out of this skill entirely.

**Two consequences, both hard rules:**

1. **The model engines (`chatgpt`, `claude`, `gemini`) are collected on the agent lane** — a
   headless CLI/SDK process on the user's subscription, which carries no chat history and no memory
   — with a **provider API key** as the only fallback. There is no browser route for them any more.
2. **`google_ai_mode` has exactly two routes: `playwright` or `serpapi`.** Both are clean rooms:
   Playwright launches a **fresh profile that is not signed in to Google**, and SerpApi queries
   server-side with no account at all. Never point Playwright at the user's real Chrome profile
   (`--user-data-dir` on their default profile) — that reintroduces exactly the personalization
   this rule exists to remove.

If a route would require signing in to a consumer chat account, it is not a route — offer setup for
the agent lane or an API key instead (`SETUP-ROUTES.md`).

## Live data comes from the MCP, never from memory

The intent slugs, the platform list, the prompt templates, and the exact `servedModel` /
`apiModelId` each platform requires are **live catalog** from the backend's own tables — they have
already changed by migration more than once (`gpt-4o`→`gpt-5.5`, `gemini-2.5-pro`→`gemini-3.5-flash`,
and 2026-07-29 `gemini-3.5-flash`→`gemini-3.6-flash`, with `3.5-flash` kept as the managed lane's
in-platform fallback — see the fallback ADR). Never hardcode, recall, or invent them — that history is
exactly why. Fetch every run: `get_byok_skill`, `describe_check_grid` (its response already carries
the full `intents` list — no separate `list_intents` call needed), `get_prompt_templates`,
`get_product_name_rules`, `get_template_localization_rules`, and — for the client-side analysis at
P4.5, which runs **by default** — `get_detect_extraction_spec`.
The validator that rejects your payload reads the same catalog — the MCP is the only source that
can't drift.

## Credentials — enter once, reuse, never echo

Secrets live in a dotenv file **outside this bundle**: `~/.config/mention-network/credentials`
(override with `$MENTION_NETWORK_CREDENTIALS`), `chmod 600`, managed by `scripts/credentials.mjs`.
It never enters the bundle, the `.tgz`, or git.

- Load it at the start of every run (P1) and never re-ask for a secret that's already there.
- When the user supplies a new secret, offer to save it — value read from the env, not argv, so it
  isn't echoed: `OPENAI_API_KEY='<pasted>' node "$HERE/scripts/credentials.mjs" save OPENAI_API_KEY`.
- Subscription logins (`claude` / `codex`) are already persisted by those CLIs' own login stores —
  nothing to save here.
- `MENTION_NETWORK_KEY` can be stored, but the MCP is launched by the Claude host — what actually
  persists the connection is `claude mcp add` / the host config / the shell profile.
- **Never print a secret.** `status` masks to the last 4; consume values only by sourcing the file.

---

## P0 — Parse the invocation

No arguments → guided run, skip to P1. Arguments present → read **`ARGUMENTS.md`** and extract
`domain`, `lane`, per-engine routes, key-values, flags. Every token is **order-free** (the domain
too — find it by shape); routes may be pinned as `route(engine, …)`, `engine=route`, or
`group=route` where **`llm` means the three model engines** (`chatgpt`, `claude`, `gemini`) and
never `google_ai_mode`; and obvious misspellings (`playwwight` → `playwright`, `ai-mode` →
`google_ai_mode`) are corrected silently. Parsing never fails the
run: an unrecognized token becomes a note on the confirm card.

`resume` present → read **`RECOVERY.md`** and pick up the existing run directory instead.

## P1 — Preflight: one batch, ask nothing

Everything here runs before the user is asked anything, so every option in Q1 is backed by a real
value. Run it as one batch and read the results together.

> **One stop condition fires inside P1, before any question:** `MENTION_NETWORK_KEY` missing **and**
> no host MCP tool answering ends the run right here with a request for the key — see *No key stored
> at all* below. It **outranks `dry-run`**, which stops at the confirm card; when both apply, the
> key blocker wins because there is no plan to confirm. The batch below is only half of P1 — the
> bulleted probes after it carry the rules that decide whether the run can proceed at all.

```bash
HERE="$(dirname "$(readlink -f "<abs path to this SKILL.md>")")"   # this skill's folder
CREDS="${MENTION_NETWORK_CREDENTIALS:-$HOME/.config/mention-network/credentials}"
set -a; [ -f "$CREDS" ] && . "$CREDS"; set +a        # stored secrets into this shell, unechoed
node "$HERE/scripts/credentials.mjs" status          # masked: stored | env only | missing
command -v codex claude gemini || true               # agent lane CLIs — all three engines
node -e "require.resolve('@anthropic-ai/claude-agent-sdk')" 2>/dev/null \
  && echo "agent-sdk: ok" || echo "agent-sdk: missing"
# gemini's agent lane only works on API-key auth — oauth-personal is a dead tier (see below)
node -e "try{console.log('gemini auth:',require(require('os').homedir()+'/.gemini/settings.json').security?.auth?.selectedType||'unset')}catch{console.log('gemini auth: no settings.json')}"
curl -s -o /dev/null -w '%{http_code}' "https://<shopDomain>/products.json?limit=250"
```

Alongside it, in the same batch:

- **MCP alive?** One cheap call (`get_shop({shopDomain})`).
  **No `mention-network` tools in the session is *not* a blocker.** `scripts/mcp-client.mjs` speaks
  the same MCP over plain HTTP using `MENTION_NETWORK_KEY`, so a stored key is enough to run the
  whole skill (measured 2026-07: a full 20-cell run completed in a session where the host had no
  `mention-network` tools at all). Try that path before asking the user for anything:
  ```bash
  node --input-type=module -e "
  const { callTool } = await import('$HERE/scripts/mcp-client.mjs')
  console.log(JSON.stringify(await callTool('get_shop',{shopDomain:'<domain>'})))"
  ```
  Use `callTool` for every MCP call in that case — the tool names and arguments are identical.
  Only when **both** the host tools are absent **and** that HTTP call fails is the MCP genuinely not
  set up. Then, and only then:
  ```bash
  export MENTION_NETWORK_KEY=<their-key>       # from mention.network — never invent one
  claude mcp add mention-network --transport http \
    https://shopify-mcp-dev.mention.network/api/v1/mcp \
    --header "Authorization: Bearer ${MENTION_NETWORK_KEY}"
  ```
  (Running this bundle *as* a plugin? The shipped `.mcp.json` already declares it — they only need
  `export MENTION_NETWORK_KEY=...` and a reload.) A **401** is a wrong key, not a missing one — see
  `RECOVERY.md`.

  > **No key stored at all is the first-run blocker — handle it before Q1, not after.** This is the
  > most common way a brand-new user lands here, and there is no way to work around it: the MCP is
  > where the prompt templates, the intent list, the grid and the validator live, so **every lane
  > needs it**. Without it you cannot render a prompt (P3), cannot validate (P5), cannot submit
  > (P6), and cannot state a real cell count on the confirm card.
  >
  > So when `credentials.mjs status` says `MENTION_NETWORK_KEY: missing` **and** no host tool
  > answers, **stop before the confirm card** and say plainly: the run needs a key, here is where to
  > get one (log in at mention.network), and here is how to store it —
  > ```bash
  > MENTION_NETWORK_KEY='<pasted>' node "$HERE/scripts/credentials.mjs" save MENTION_NETWORK_KEY
  > ```
  > Then re-probe and continue the run. **Do not build a speculative confirm card with UNKNOWN in
  > the coverage line** to look like progress — an estimate you can't compute is not a plan, and the
  > user would be approving a run that cannot start. Asking for the key *is* the useful next step.
- **Agent lane, per engine** — `codex` covers `chatgpt`, the Agent SDK or `claude` CLI covers
  `claude`, `gemini` covers `gemini`. A binary on `PATH` is **not** proof it is logged in, so
  **resolve that in P1 rather than carrying "unverified" onto the confirm card** — a route the user
  approves must be one you know works. The cheap probes:

  ```bash
  codex login status                       # free + instant: "Logged in using ChatGPT", else non-zero
  claude -p "say ok" --allowedTools ""     # one trivial call on the subscription; no keychain read
  gemini --skip-trust -o text -p "say ok"  # only worth running if selectedType is already gemini-api-key
  ```

  `codex login status` costs nothing — always run it. The `claude` and `gemini` probes each cost one
  throwaway model call, which is free on a subscription and far cheaper than discovering the login
  is dead after the user approved a 15-cell grid. Skip a probe only when its engine was already
  ruled out. For `gemini` specifically, read the `selectedType` printed above:
  **`oauth-personal` means the route is dead** (`IneligibleTierError` — Google retired the free
  "Code Assist for individuals" tier; measured again 2026-07-28 on a freshly logged-in account) and
  it needs the one-line switch to `gemini-api-key` in `SETUP-ROUTES.md`, not a re-login.
- **`google_ai_mode` routes** — is the `playwright` MCP in **this session**, and is
  `SERPAPI_API_KEY` stored? Those are the only two. `claude-in-chrome` is not a route in this skill
  — do not probe for it and do not offer it.
- **Store + catalog** — `get_shop` (reuse `primaryLocale` as the language hint; `SHOP_NOT_FOUND`
  just means never-checked) and `list_shop_products`. The backend's product view is often sparse
  (measured: **1** product for a store whose storefront listed a full catalog), so also read
  **`https://<shopDomain>/products.json`** — Shopify exposes it publicly (`?limit=250&page=N`), and
  each product carries `id`, `title`, `handle`, `vendor`, `product_type`, `variants[0].price`, and
  **`images[0].src`** — everything the Snapshots shape needs, image included. `list_shop_products` /
  `get_shop` often return `imageUrl: null` (the backend's own sync doesn't populate it yet), so the
  storefront JSON is the reliable source for the product image.
- **Recent run** — `list_visibility_checks({shopDomain})`. A `status: completed` item with
  `finishedAt` inside 7 days is worth offering before spending anything.

Map the probe to **engines, not routes** — coverage is what the user cares about.

## P2 — Resolve the plan *(this produces pre-selections, not decisions)*

Combine what was parsed (P0), what was probed (P1), and the defaults, and produce a plan with no
blanks. **Every value here that the invocation did not supply is a candidate — the first option in
its Q1 question, not the answer.** Read the whole of this section that way; "resolve" below always
means "work out the best option to offer", never "settle it". Values the invocation *did* supply are
settled, and are not asked about again.

That distinction is the single easiest thing to get wrong in this skill: measured 2026-07, a full
run went out with all four routes chosen silently, and the user only found out by reading the plan
block afterwards.

- **Lane** — `byok` unless the user said `backend`.
- **Market** — the parsed `country=`, else inferred from the domain (a store named `…arabia.com` →
  SA / AE / EG). **An inference is the first option in Q1, not the answer** — if `country=` wasn't
  supplied, it gets asked.
- **Language** — the market's **local** language leads (the MCP's own instruction: a non-English
  market measured in English gives a different ranking), with English as the alternative. Again: if
  `lang=` wasn't supplied this is **asked**, never assumed. `get_shop.primaryLocale` is a hint for
  ordering the options; it is frequently `null`, and it describes the *website*, not the shopper.
- **Product** — from the storefront catalog, else `list_shop_products`, else seed one or two
  plausible flagship titles for the user to pick. **Never invent one silently.**
  `/products.json` is ordered by the store's own collection sort, **not** by sales — so position 1
  is not a bestseller and must never be presented as one. When it is your only source, **offer 3–4
  titles as the Q1 product options** rather than silently pre-picking the first, and say which
  signal you used (recognizable brand, price band, the market's category). Pre-selecting one is
  fine; passing off an arbitrary pick as "the flagship" is not.
- **Route per engine** — rank the candidates with `ARGUMENTS.md`: for the three model engines
  **CLI → API key**, and `google_ai_mode` separately (`serpapi` / `playwright` only). The winner
  becomes the *(Recommended)* option at Q1 — pinned engines excepted, which are settled.
  Repair impossible pairs and record one repair line per changed engine.
  **A CLI that isn't logged in is still the CLI route** — mark it `⚠ needs login`, keep it on the
  card, and carry its exact setup command into Q1. Do not silently promote the API key over it: the
  user pays for the API key and not for the login they already have.
- **Estimate** — cell count (platforms × intents), rough minutes, and cost. Agent-lane cells are one
  process each and **fan out**, so the model engines finish in roughly the time of the slowest
  single cell. Name any metered route explicitly (`OPENAI_API_KEY`; gemini on a key — CLI or API —
  spends AI Studio free-tier quota). `google_ai_mode` on Playwright is **serial**: one browser, ~5
  tool calls per cell; on SerpApi it is one search per cell out of the free ~100/month.

## Q1 — The confirm card *(asking moment 1 of 3)*

One `AskUserQuestion`. Show the resolved plan first as a compact block, then offer the options.

```
Shop      kbeautyarabia.com  ·  SA  ·  Arabic
Product   COSRX Advanced Snail 96 Mucin Power Essence
Lane      BYOK (your own subscriptions — the backend spends nothing)
Routes    chatgpt  codex CLI          free      ✓ logged in
          claude   claude CLI         free      ✓ logged in
          gemini   gemini CLI         free      ⚠ needs the gemini-api-key switch — I'll do it
          google_ai_mode  SerpApi     ~4 of your free 100 searches
Coverage  4/4 engines · 20 cells · ~8 min · $0 · clean room (no logged-in chat UI)
```

### What goes in the Q1 call

`AskUserQuestion` takes **at most 4 questions**. **One rule generates the list: anything the
invocation did not supply gets asked; anything it did supply is not.** Compose in this order:

1. **Product** — ask unless `product=` was supplied. Offer 3–4 real titles from the catalog.
2. **Market + language** — ask unless **both** `country=` and `lang=` were supplied. One question:
   the market and the language it will be asked in are a single decision.
3. **Routes for the model engines** (`chatgpt` / `claude` / `gemini`) — ask unless the arguments
   pinned them (`engine=route`, `llm=cli`, `route(engine)`). They can mix.
4. **Route for `google_ai_mode`** — ask unless pinned. Its own question, always.

**The rule runs both ways — never re-ask what the shorthand already answered.** A user who typed
`product="Water Bank" country=SA lang=ar llm=cli ai-mode=serpapi` has made every decision there is;
asking them again is noise that makes the shorthand pointless. Show those values on the card so they
can still be corrected, and ask nothing about them.

**When everything was supplied**, none of the four fire — then ask the single confirm question
(*Run it (Recommended)* · *Change product* · *Change market or language*) so the card still gets an
answer. Design contract 3: the card always shows.

**An access gap usually needs no question of its own.** When question 3 or 4 is firing, the gap
rides along inside it as a ⚠ row on the affected engine (*"chatgpt: codex ⚠ not logged in →
`! codex login`"*) — the user picks a route and accepts its setup step in one click.

It becomes a **separate, 5th question only when the route was already pinned** by the invocation, so
there is no route question left to attach the ⚠ to. In that case **don't drop one of the four to fit
it** — ask the four, then handle the gap in the next turn: setup needs a round trip anyway (the user
runs `! codex login`, you re-probe), so it was never going to fit in the same breath.

> ### Never decide the product or the language for the user
>
> Same rule as routes, and it is broken the same way: P2 resolves a sensible default, Q1 shows one
> *"Run it (Recommended)"*, the user clicks it, and a product and a language they never chose are
> now on a customer-facing report.
>
> **An inferred value is a pre-selected option, never a decision.** `…arabia.com` → SA is a good
> guess for the *first option*, not a licence to skip the question. The same goes for taking the
> market's local language, and for picking a product out of the catalog.
>
> These two are not cosmetic:
> - **Language changes the answer, not the wording.** The MCP says so itself and `get_byok_skill` §1
>   backs it with a measurement: the same question in English and in the local language produces
>   **materially different rankings**. Choosing it silently picks which market's reality gets
>   reported.
> - **The product is the entire subject.** `/products.json` is ordered by the store's collection
>   sort, not by sales, so "the first one" is arbitrary — and a report about the wrong product is
>   simply the wrong report, at full quota cost.
>
> Only `product=` / `country=` + `lang=` in the arguments, or `yes` (which skips the whole card),
> authorise proceeding unasked. Under `yes`, print both values in the plan block marked `(auto)`.

> ### Never choose a route for the user on your own
>
> **The ranking decides what is *pre-selected*, never what is silently used.** An engine whose route
> the arguments did not pin gets a question — every run, even when the ranking's answer is obvious
> and even when only one route works. Resolving routes in P2 and skipping straight to *Run it* is
> the single easiest way to get this skill wrong: measured 2026-07, a full run went out with all
> four routes chosen silently and the user only found out by reading the plan block.
>
> Skip a route question **only** for engines the arguments already pinned (`ARGUMENTS.md`) — by
> `route(engine)`, `engine=route`, or a group like `llm=cli` — and even then show the resolved route
> per engine on the card, so a group's expansion and any repair stay visible. A group that pinned
> three engines still owes the user those three lines; never collapse it back to "llm: cli".
>
> Exactly two tokens authorise taking the ranking's pick unasked, and nothing else does: **`auto`**,
> and **`yes`** (which skips the whole card, so no question survives to ask). Under either, print
> every auto-chosen route in the plan block marked `(auto)` — the user still gets to see what was
> decided for them, just after the fact instead of before.

### The two methods, and the rule that governs the options

Each model engine has exactly **two** collection methods. Both are clean rooms; the choice is about
cost and fidelity, never about whether the engine gets measured at all:

| Engine | **CLI** (agent lane) | **API key** |
|---|---|---|
| `chatgpt` | `codex` — free on a ChatGPT plan | `OPENAI_API_KEY` — metered |
| `claude` | `claude` CLI, or the Agent SDK — free on a Claude plan | — none wired up |
| `gemini` | `gemini` CLI — free-tier AI Studio key | `GEMINI_API_KEY` — free tier, real `servedModel` |

> ## Always list the CLI. Never offer to drop an engine.
>
> **Every route question names all three engines, and every one of them shows its CLI option** —
> including engines whose CLI is not logged in yet. A missing login is a **10-second setup step**,
> not a reason to demote or omit the engine.
>
> **There is no "skip it" / "drop that engine" / "run without it" option.** Not because it is impure
> — because it **cannot work**: the backend requires the full platform × intent grid and rejects a
> short submission with `INCOMPLETE_PLATFORM_GRID` / `INCOMPLETE_INTENT_GRID` (`get_byok_skill` §0:
> *"If you cannot reach one engine, fix the access rather than dropping the engine."*). Offering a
> partial BYOK run spends the user's whole quota and then fails at submit. Measured 2026-07-28: a
> real run was offered exactly that option before this rule existed.
>
> When an engine's CLI isn't logged in, the option stays on the list and **carries its login command
> inline**. The only legitimate answers to "this engine has no working access" are **log in**, **use
> its API key**, or **switch the whole run to the backend lane** — never a smaller grid.

Build each option from **what actually works on this machine** (P1), tag the cheapest working one
*(Recommended)*, and label every option with its cost and its login state. A real pair of questions
from a machine where `codex` was logged out and `gemini` sat on the dead OAuth tier:

```
Model engines — how should chatgpt / claude / gemini be collected?
  ▸ CLI for all three (Recommended)     free, parallel, headless — no chat memory
                                        chatgpt: codex     ⚠ not logged in → `! codex login` (~1 min)
                                        claude:  claude CLI  ✓ logged in
                                        gemini:  gemini CLI ⚠ needs the gemini-api-key switch (~1 min)
  ▸ CLI for chatgpt/claude, API for gemini   gemini via GEMINI_API_KEY — real servedModel,
                                             same free quota, skips the settings.json switch
  ▸ API keys where one exists           chatgpt: OPENAI_API_KEY (metered) · gemini: GEMINI_API_KEY
                                        claude has no API route → its CLI is used either way

Google AI Mode — collect with?      (no model API exists, so it is asked separately)
  ▸ SerpApi (Recommended)           key stored, server-side, no account, parallel
  ▸ Playwright                      free, fresh signed-out profile, serial ~5 calls/cell
```

Note what the ⚠ rows do **not** say: they don't demote the engine and they don't propose leaving it
out. They state the gap and the one command that closes it. After the user picks, walk the setup for
every ⚠ engine in that option (`SETUP-ROUTES.md`), re-probe, and confirm coverage before collecting.

Never fold `google_ai_mode` into the model-engine question, and never let a model-engine choice
stand in for it: those routes can't reach it and the missing cell fails the submit with
`MISSING_CELL`.

**Both questions offer only clean-room routes.** There is no "collect it in my browser" option for
`chatgpt` / `claude` / `gemini` — don't invent one, and if the user asks for it, explain the memory
contamination and offer the agent-lane setup instead. If the user insists after hearing that, it is
their call: say plainly in the plan block and in the handover that those cells were collected from
a personalized account, so the report measures that account rather than the market.

**Access gap** — if an engine has no working access yet, this question is **how to get it**, never
whether to live without it. There are exactly two answers, because a short grid is rejected:

1. **Set it up now (Recommended)** — walk `SETUP-ROUTES.md` for exactly the engines that need it,
   with the concrete command and its real cost (*"`! codex login` covers chatgpt on the ChatGPT plan
   you already pay for; the gemini one-liner + a free AI Studio key covers gemini — about 2 minutes
   total, no cost"*). Then re-probe and re-state coverage before spending anything.
2. **Backend-run instead** — the backend queries all four on its own keys. The right call when the
   user has no ChatGPT/Claude plan and doesn't want to create keys; it costs the backend's AI budget
   and the run is no longer BYOK.

**Do not add a third option.** "Run it with 3 engines", "skip gemini for now", "we can add chatgpt
later" — all of these end in `INCOMPLETE_PLATFORM_GRID` after the quota is spent. If the user asks
for one anyway, say plainly that the backend rejects partial grids, and offer these same two.

Interactive logins belong to the user — hand them the command (`! codex login`, `/login`) rather
than driving the browser flow yourself, and **wait for them to say it's done before re-probing**: a
probe fired while the browser flow is still open comes back "not logged in" and reads as failure.
Do the non-interactive parts yourself (the gemini `settings.json` switch, saving a key) so the user
only does what genuinely needs a human.

*`dry-run` stops here. `yes` skips this card but still prints the plan and every repair line.*

**Lane = backend → jump to Lane A.** Lane = byok → continue.

## P3 — Build the prompts

Fetch the live catalog: `get_byok_skill` (the authoritative playbook — follow it), then
`describe_check_grid` (its `intents` field IS the `list_intents` data — don't call it twice),
`get_prompt_templates({language})`, `get_product_name_rules`, `get_template_localization_rules`.

- **Decide the grid** — platforms × intents. `where_to_buy` is **mandatory**; every declared cell
  must be collected.
- **Render the actual prompt per intent** — apply the template with the normalized product name, in
  the prompt's language (localization rules).

## Q2 — Approve the prompts *(asking moment 2 of 3)*

Render a table (intent → the exact prompt) plus the normalized product name and market/language,
then ask: **Approve and run (Recommended)** / **Edit a prompt**. Don't force wording work on a user
who's happy with it.

If they edit, preserve two invariants or the submit is rejected:
- **one prompt per intent, identical across platforms** (`INCONSISTENT_PROMPT_TEXT`);
- `where_to_buy` stays in the set (`MISSING_WHERE_TO_BUY`).

Write the approved table to `prompts.md` in the run directory — it's the record of what was asked.

## P4 — Collect

Create the run directory (`RECOVERY.md`) and collect **every declared cell** with the approved
prompt. Source the credential store first so the collectors see the stored keys:

```bash
HERE="$(dirname "$(readlink -f "<abs path to this SKILL.md>")")"
CREDS="${MENTION_NETWORK_CREDENTIALS:-$HOME/.config/mention-network/credentials}"
set -a; [ -f "$CREDS" ] && . "$CREDS"; set +a
```

**Web search must actually run for every cell** (`WEB_SEARCH_REQUIRED`). Every collector here
forces it on already — the Agent SDK via `allowedTools:["WebSearch"]`, `codex` via
`tools.web_search=true`, `claude` via `--allowedTools WebSearch`, `gemini` via its builtin
`google_web_search`, and the API/SerpApi collectors in the request itself. Set `webSearchUsed: true`
only when search genuinely ran; the Agent SDK collector **throws** rather than lie. Citations are
*not* required. **Never fake the flag** — re-run the cell or collect it on another clean-room route.

**Collect in parallel — this is where the wall-clock time goes.** Each collector is an independent
process writing its own `cells/<intent>.<platform>.json`, so cells share no state. Group by route
and run each group as a pool:

- **API / SerpApi / Agent SDK** — safe to run concurrently; cap ~4–6 in flight per provider key. On
  `429`/quota (and Gemini's frequent `503`), back off and retry that one cell — a single failure
  shouldn't sink the batch.
- **Vendor CLI** (`codex`, `claude`, `gemini`) — separate processes too, but a subscription often
  allows only a few concurrent sessions; keep it to 2–3 per CLI. They are slower per cell than an
  API call (an agent loop, not one request) — budget ~40–90s each.
- **Playwright `google_ai_mode`** — one shared browser, so these cells are inherently **serial**
  (parallel clicks race the same DOM). Kick the agent-lane pools off first and let the serial
  `google_ai_mode` cells fill in alongside them.

Practical fan-out: launch each `node …collect-*.mjs … &`, collect PIDs, `wait`, then assemble. Wait
for **all** cells (fail none silently) and update `state.json` as each finishes. **Or use
`scripts/collect-pool.mjs`**, which pools exactly this way from a grid file (one job per cell:
`{route, engine|provider|hl/gl, intent, platform, prompt, out}`), capped per SKILL.md's own
numbers (CLI 2, API/Agent SDK/SerpApi 4 by default, overridable with `--concurrency`), with one
outer retry per cell. Measured 2026-07-28: a real run's CLI cells landed with multi-minute gaps
between them instead of overlapping — collection alone was 5m41s of an 8m54s run — because the
fan-out was hand-rolled that time and drifted serial. It does not cover `google_ai_mode` on
Playwright (no collector script exists for that route, see below) — run those cells the usual

> **Give the call itself enough wall-clock room — a killed wrapper is not a route failure.**
> However you invoke `collect-pool.mjs`/`collect-cli.mjs`, if you're calling it through a tool with
> its own default execution timeout (a plain foreground shell call, for instance), that default is
> very likely shorter than a full grid needs — `gemini` cells alone run ~40–90s each. Pass an
> explicit long timeout or run it truly in the background and poll; don't let the wrapper get
> killed mid-flight and then read that as the collector or the route being broken. Measured
> 2026-08-01: exactly this mistake burned ~10 minutes retrying the same 3 cells before switching to
> a longer timeout fixed it in one pass. See `RECOVERY.md`'s *Timeout* rows for the full escalation
> (this case vs. the collector's own `--timeout-ms` genuinely firing).
way alongside the pool.

> **Put P4.5 on the task list now, while you're building it.** The collection tasks and
> *"validate, submit, poll, export"* are the obvious two, and a plan that contains only those two
> will skip client analysis every time — measured twice. The list needs **three** items:
> `collect cells` → **`analyze cells → detection`** → `validate, submit, poll, export`.
> When the analysis is fanned out, that middle item is itself three: *render the per-cell prompts →
> dispatch one analyzer per cell → reconcile the set with `check-detections --meta`*. The
> reconcile step is the one that gets dropped, and it is the only one that can see the whole grid.

### The collectors

Every `collect-*.mjs` takes `--intent <slug>` (and optional `--platform`); with it, `--out` is
written as the whole `byokCellShape` — `{ intentSlug, platformSlug, promptText, collectionMethod:
'api'|'cli'|'browser', response: {…} }` — so a `cells/` dir drops straight into `submit.mjs` with no
hand-wrapping. Without `--intent` you get the bare `response` and must wrap it yourself.

| Route | Command |
|---|---|
| **Agent SDK** (`claude`) | `printf '%s' "<prompt>" \| node "$HERE/scripts/collect-agent-sdk.mjs" --intent where_to_buy --out cells/where_to_buy.claude.json` |
| **Vendor CLI** (`chatgpt`/`claude`/`gemini`) | `printf '%s' "<prompt>" \| node "$HERE/scripts/collect-cli.mjs" --engine chatgpt --intent where_to_buy --out cells/where_to_buy.chatgpt.json` |
| **API key** (`chatgpt`/`gemini`) | `printf '%s' "<prompt>" \| node "$HERE/scripts/collect-api.mjs" --provider openai --model "<apiModelId>" --intent where_to_buy --out cells/where_to_buy.chatgpt.json` |
| **SerpApi** (`google_ai_mode`) | `printf '%s' "<prompt>" \| node "$HERE/scripts/collect-serpapi.mjs" --hl <lang> --gl <country> --intent where_to_buy --out cells/where_to_buy.google_ai_mode.json` |

- **Agent SDK** — one headless `query()` with `allowedTools:["WebSearch"]` on the user's plan. The
  SDK message stream always reports which model it actually used (`message.model`) — that's an
  **observation**, not a guess, so the collector declares it as `servedModel` and submits
  `collectionMethod:'cli'` (checked against `requiredServedModel`, same as the `api` lane; #294).
  A mismatch is a **warning** (`SERVED_MODEL_MISMATCH`, ADR-0036) — it does **not** block the
  submit, and whatever you declare is what gets stored and shown on the report, not the catalog
  value. Forces the subscription by unsetting `ANTHROPIC_API_KEY` for its own process
  (`--allow-api-key` opts out). **Throws** if web search didn't run or the SDK isn't installed —
  fall back to the `claude` CLI rather than npm-installing mid-run.
- **Vendor CLI** — drives `codex`/`claude`/`gemini` signed into the user's own plan with web search
  on, scrapes citations. Pass `--model <id>` (the grid's `requiredServedModel`) for `claude`/`gemini`
  and the cell declares `servedModel` for real, submitted as `collectionMethod:'cli'` — **checked,
  but only a warning on mismatch (ADR-0036), never a rejection**. `chatgpt`/`codex` stays an
  auto-router with no controllable model, so it (and any call without `--model`) still writes a
  `collectionMethod:'browser'` cell with `servedModel` empty — the old, unchecked shape, unchanged
  (#294 resolved the gap where *every* CLI cell had to claim `browser` even when the model was
  known, e.g. an agent quietly switching `gemini-3.5-flash` → `gemini-3.6-flash` on a 503 with
  nothing to catch it — note this exact pair is no longer just a hypothetical: as of 2026-07-29
  `gemini-3.6-flash` genuinely IS the managed lane's default and `gemini-3.5-flash` its declared
  fallback, so `requiredServedModel` from `describe_check_grid` now legitimately says
  `gemini-3.6-flash` — pass `--model` with THAT value, not a hardcoded one, or you'll get a
  `SERVED_MODEL_MISMATCH` warning for a cell collected on the old model; submit still succeeds,
  but the report will show that older model, not the one you meant).
  Self-times-out (`--timeout-ms`, default 180s) — **don't rely on the `timeout` binary, macOS
  doesn't ship it.** Flags drift; the collector encodes the 2026-07 forms.
  **`--engine gemini` works, but only on API-key auth** — the free `oauth-personal` tier throws
  `IneligibleTierError`, so `~/.gemini/settings.json` needs `security.auth.selectedType:
  "gemini-api-key"` with `GEMINI_API_KEY` exported (`SETUP-ROUTES.md` has the one-liner). Verified
  end-to-end 2026-07-28: a Saudi `where_to_buy` cell came back with 6 real retailer citations.
- **API key** — a genuine `api` cell: `collectionMethod:'api'`, `servedModel` = the `apiModelId`
  from the live grid. Transient `429`/`5xx` are retried with backoff (measured: Gemini `503`).
- **SerpApi** — the real AI-Mode answer + source links. `collectionMethod:'browser'`, `servedModel`
  **empty**, `webSearchUsed: true`. Throws without `SERPAPI_API_KEY`.
- **Playwright** (`google_ai_mode` only) — there is **no collector script**: drive the MCP yourself
  and write the cell file. `collectionMethod:'browser'`, `webSearchUsed: true`, and `servedModel`
  **empty**. Any `servedModel` on a browser cell is `UNEXPECTED_SERVED_MODEL` — `get_byok_skill`'s
  own `google_ai_mode` section says the same thing: the validator wins over any table value.

### Driving Playwright for `google_ai_mode`

Chose `playwright` over the `(Recommended)` `serpapi` for this run? Read **`COLLECT-PLAYWRIGHT.md`**
now — it covers navigating AI Mode, waiting out the stream, trimming the answer body correctly
(the naive DOM heuristic is measured wrong), citations, and the locked-profile / CAPTCHA edge
cases. Nothing below this line is specific to Playwright.

> **Resolved 2026-07-29 (#294) — how an agent-lane cell maps.** `collectionMethod` is now
> `'api' | 'cli' | 'browser'`. Rule of thumb: **if you (the agent) know which model actually
> answered, declare it and use `'cli'`** — it is checked against `requiredServedModel` exactly like
> `'api'`. Use `'browser'` (empty `servedModel`, unchecked) only when the model is genuinely
> unobservable — a real signed-in UI, or `chatgpt`/`codex exec`'s auto-router. Concretely:
> - **Agent SDK** — always knows (`message.model`) → always `'cli'`.
> - **Vendor CLI, `claude`/`gemini`** — pin it with `--model`/`-m` → `'cli'`; omit it → `'browser'`.
> - **Vendor CLI, `chatgpt`/`codex`** — no controllable model → always `'browser'`.
>
> Payloads written before #294 that declared `'browser'` for what was really a CLI-collected cell
> stay valid (accepted, not migrated) — `'browser'` keeps its old unchecked semantics, so nothing
> old breaks. Only new cells that declare `'cli'` get the model check.
>
> **Since ADR-0036 (nới #294 further): the model check on `'api'`/`'cli'` no longer blocks.** A
> mismatch against `requiredServedModel` produces `SERVED_MODEL_MISMATCH` as a **warning** in
> `validate_byok_submission` / `submit_byok_check` — the submit still succeeds. What is still
> guaranteed: the `servedModel` you declare is stored as-is (`ai_responses.served_model`) and is
> what the report should be able to show back, not silently coerced to the catalog value. Declare
> it honestly regardless — a catalog mismatch is now recoverable, a false declaration is not.
> `google_ai_mode` and `'browser'` are **unaffected** — a declared `servedModel` there is still a
> hard-blocking `UNEXPECTED_SERVED_MODEL`, because that is a place where a model cannot honestly be
> observed at all, not a catalog-drift case.

## P4.5 — Analyze the answers yourself · **default ON, not an optional extra**

**This step runs on every BYOK run unless the user says otherwise.** Put it on the P4 todo list as
its own task now (*"Analyze 20 cells → detection"*), before you go read the details — measured
2026-07-28: two real runs went straight from *"collect cells"* to *"validate, submit, poll,
export"* because the todo list never contained this step, and if it isn't on the list it doesn't
happen.

Read **`ANALYSIS.md`** now for the full playbook: fetching `get_detect_extraction_spec`, rendering
one prompt per cell, delegating to one sub-agent per cell safely, the price/shipping and non-Latin
merchant guards, the self-check command, and the three legitimate reasons to skip it.

## P5 — Validate

```bash
node "$HERE/scripts/submit.mjs" --cells cells/ --validate-only
```

Runs `validate_byok_submission` over the whole dir and prints each error. **Don't inline the cells
array into the MCP tool call by hand** — a full grid is tens of KB of answer text (15 Arabic cells
measured at ~66 KB), slow to reproduce and easy to mis-escape.

Fix and re-run until clean. `RECOVERY.md` maps every error code to its fix; auto-repair up to two
rounds before involving the user. Keep only cell files in `cells/` — `submit.mjs` reads every
`*.json` there as a cell, so `meta.json` and `state.json` live outside it.

`submit.mjs` prints a `detection` coverage note every time it runs (validate-only or full submit):
silent when every cell carries one, a warning when 0 do (P4.5 didn't run — the backend will
analyze every cell itself) or when it's partial (`DETECTION_PARTIAL`, which the validator also
rejects). That note is there so a skipped P4.5 shows up in the tool output itself, not only in a
todo list an agent can forget to write — measured twice before this existed.

> **A clean validate does not mean the submit will pass.** `validate_byok_submission` reads the
> **cells only** — it never looks at `meta.json`. The shop/product snapshot is checked by
> `submit_byok_check`'s own input schema, which rejects with a raw zod error, not a validator code.
> So **check the meta shape yourself before submitting** (see *Snapshots* for the types that bite).

## P6 — Submit and poll

1. Write `meta.json` (`{ shop, product, locationCountry, locationCity?, language }` — see
   **Snapshots**) **outside** `cells/`, then:
   ```bash
   node "$HERE/scripts/submit.mjs" --cells cells/ --meta meta.json     # → { checkRunId, deduped }
   ```
   It generates a **fresh `idempotencyKey`** each call; reusing one returns the prior run
   (`deduped: true`) and produces no new report.
2. Poll `get_visibility_check_status({checkRunId, shopDomain})` (≤15× / 12s) to **top-level
   `stage: done` / `status: completed`** — read those, *not* the per-engine states: an engine you
   didn't submit stays `queued` forever. Save `checkRunId` to `state.json` as soon as you have it.
3. `get_visibility_report({checkRunId, shopDomain})` → the report + its `reportId`.

## P7 — Export and show the link immediately

As soon as the report exists, `export_visibility_report_pdf({reportId})` → a hosted PDF **URL**.

> **A 500 here is often transient, and it is not the run failing.** The report already exists — only
> the PDF render broke. Retry, wait, retry again before calling it down (measured 2026-07-28: a
> `reportId` that failed twice exported fine ~15 min later), and render locally so the user isn't
> blocked meanwhile. The response's **`cached`** flag says whether you actually exercised generation
> at all — see `RECOVERY.md` before concluding *anything* about why it failed.

**Show the user the link now**, with a one-line verdict (score / visible state). No local Chrome
needed. Don't make them wait on anything else. If the export fails, fall back to the local renderer
(`RECOVERY.md`).

## Q3 — Website audit? *(asking moment 3 of 3)*

The audit is extra work and extra wait, so it's **optional, never automatic**. Skip this question if
the invocation carried `audit=yes` or `audit=no`.

- **Yes:** `create_website_audit({reportId, shopDomain})` → poll `get_website_audit_status({auditId,
  shopDomain})` (≤15× / 12s) to `completed` → `get_website_audit_report({auditId, shopDomain})` →
  `export_website_audit_pdf({auditId})`, and **show that link too**.
- **No:** stop — the visibility PDF is the finished deliverable.

**Return** the PDF link(s), the lane and routes actually used, whether the run was reused or fresh,
and — for BYOK — the `source: byok` disclosure.

*Offline alternative for either PDF:* assemble `report.json` (`{ meta, visibility, audit }`) and run
the **shared** renderer. `render.mjs` sits in `shared/`, but *where* that folder is depends on how
the skill was installed, so resolve it rather than assuming — a skill installed from the Tracy
registry gets its own directory copied and nothing beside it, so a sibling `shared/` would simply
not be there:

```bash
# $HERE = this skill's folder. Vendored copy first (registry / single-directory installs),
# then the pack root (plugin bundle, or this repo's own layout).
PACK="$HERE"
[ -d "$PACK/shared" ] || PACK="${CLAUDE_PLUGIN_ROOT:-$(cd "$HERE/../.." && pwd)}"
node "$PACK/shared/render.mjs" --data report.json --out out/<shopDomain>-<date>.pdf
```

(needs Node ≥18 + Chrome) for a locally-rendered branded PDF.

---

## Lane A — backend-run

The backend queries the providers on *its* keys; the user supplies nothing but
`MENTION_NETWORK_KEY`. P3–P5 don't run.

1. **Reuse or fresh.** P1 already fetched `list_visibility_checks({shopDomain})` — each item has
   `id` (= **checkRunId**) and `reportId`. A `status: completed` item finished within 7 days was
   offered at Q1. Otherwise `create_visibility_check({shop, product, locationCountry, locationCity,
   language})` (upserts shop+product, returns `checkRunId`) and poll to `stage: done`.
2. `get_visibility_report({checkRunId, shopDomain})` → report + `reportId`.
3. Continue at **P7**.

## Snapshots (both lanes)

`shop`: `{ platform:'shopify', externalId, storeUrl, name, primaryDomain?, countryCode?, currency?,
timezone? }`. `product`: `{ externalProductId, title, handle?, vendor?, productType?, price?,
currency?, imageUrl? }`. Prefer values from `get_shop` / `list_shop_products` / the storefront
catalog; if the store was never checked, build them from what the user gives — a stable `externalId` /
`externalProductId` suffices for the upsert.

**`imageUrl` is no longer yours to remember.** `submit.mjs` resolves it itself — meta value first,
then `/products/<handle>.js`, then `/products.json` — and **refuses to submit** when it finds
nothing. Setting it in `meta.json` is still the fastest path (one fewer network hop), but forgetting
it can no longer ship a product with a permanently blank thumbnail: the backend writes
`products.image_url` only at trigger time, and both Recent checks and Website Audit read from there.

> **`product.price` must be a `number`.** The storefront catalog and `list_shop_products` both give
> it as a **string** (`"109.00"`), so copying either straight into `meta.json` fails the submit with
> a raw zod error — `expected number, received string` — that no validator round will catch.
> Coerce it: `price: Number(p.variants[0].price)`. Drop the field entirely rather than passing `""`
> or `null` when there's no price.

**When you don't know the `.myshopify.com` domain** (users usually give the storefront domain like
`kbeautyarabia.com`), use that storefront domain as **both** `storeUrl` and the `shopDomain` you
pass to every later call — the important thing is that the **same** string threads through
`submit` → `get_visibility_check_status` → `get_visibility_report` → the audit calls, which all
scope by it.

## Gate

- [ ] P1 ran **before** any question: MCP answered, credential store loaded, routes probed, catalog
      and recent runs fetched. The user was asked only for what genuinely couldn't be resolved.
- [ ] **No `MENTION_NETWORK_KEY` at all → the run stopped at the key request**, not at a confirm card
      with an uncomputable estimate on it.
- [ ] Every route on the confirm card was **verified, not assumed** — `codex login status` and the
      per-engine probes ran, so no engine was offered as working on the strength of a binary being
      on `PATH`.
- [ ] The user was asked **at most three times** (Q1 / Q2 / Q3), each with pre-filled options.
- [ ] The **confirm card was shown** with shop, product, market, language, lane, route per engine,
      every repair line, and cells/time/cost — unless the invocation carried `yes`.
- [ ] **Product and language were *asked* unless the invocation supplied them** (`product=`,
      `lang=`+`country=`, or `yes`). An inferred market, a local-language default, and a catalog
      pick only ever pre-selected an option — none of them stood in for the user's answer.
- [ ] **Every engine whose route the arguments didn't pin was *asked about* at Q1** — the ranking
      only pre-selected an option, it never chose on the user's behalf. `google_ai_mode` got its
      **own** question, offering only `playwright` / `serpapi`.
- [ ] **Clean room held:** no cell for `chatgpt` / `claude` / `gemini` came from a logged-in consumer
      chat UI, and any Playwright run used a signed-out profile. If the user overrode this after
      being told why, the personalization was disclosed in the handover.
- [ ] Routes were ranked **agent lane → API key** (model engines) and **serpapi/playwright**
      (`google_ai_mode`), with a missing higher rank offered as **setup** before dropping a rank.
- [ ] **Every model-engine question listed the CLI option for all three engines**, including any
      whose login was missing — with the login command inline, never as a demotion or an omission.
- [ ] **No engine dropped, no grid shrunk** (design contract 5) — the submitted grid was the full 4 × N.
- [ ] Prompts were shown and confirmed (Q2); any edits kept one-prompt-per-intent + `where_to_buy`.
- [ ] No secret was invented, and none was echoed; any new one was offered a `save`.
- [ ] BYOK only: `validate_byok_submission` returned **no errors** before submit; a **fresh**
      `idempotencyKey` was used; `webSearchUsed` reflects reality; agent-lane cells mapped per the
      open-decision note.
- [ ] **P4.5 ran** — it is the default. Every cell carries a `detection`, the spec came from
      `get_detect_extraction_spec` (never invented), and `source: byok_client_analysis` was
      disclosed: the submitter supplied the interpretation, not just the data.
      **If it did not run, the handover names which of the three allowed reasons applied** — the
      user declined, the guards couldn't be met honestly, or two `DETECTION_*` repair rounds
      failed. Silence is not one of them, and neither is "it was quicker".
- [ ] **The analysis was extracted to one standard.** If it was fanned out: every analyzer was
      briefed with its own `analysis/<cell>.prompt.md` rendered from the live spec (not a
      paraphrase), wrote `detection` into its own cell file, and the whole set was reconciled with
      `check-detections.mjs --cells cells/ --meta meta.json --fix`. No cell was re-extracted by
      hand on the strength of a disagreement that carried no code — the one exception is
      `position`, which `--fix` corrects mechanically (ADR-0040), not by re-dispatching.
- [ ] A visibility report reached `stage: done` (never present a partial or failed run as done).
- [ ] The **PDF link** (or local path) was returned; for BYOK, `source: byok` was disclosed.
