# Shorthand arguments — grammar, aliases, and route repair

Read this **whenever the invocation carries anything after the skill name**. With no arguments the
skill is fully guided and you can ignore this file (the ranking in *Route priority* below still
applies to `auto`).

```
/create-visibility-report <domain> [lane] [route(engine, …)]… [engine|group=route]… [key=value]… [flags]
```

**Every token is order-free, including `<domain>`.** Writing the lane first
(`/create-visibility-report byok kbeautyarabia.com …`) is just as valid as domain-first — users
reach for both, and neither is worth an error. Identify the domain by shape, not by position: the
token that contains a `.`, carries no `=`, and isn't a known route/lane/flag word. If two tokens
look like domains, the first wins and the second becomes a note on the card.

Parsing is best-effort and **never fails the run**: anything you can't classify becomes a note on
the confirm card, not an error.

### Three ways to pin a route — all first-class

| Form | Example | Read it as |
|---|---|---|
| `route(engine, …)` | `cli(chatgpt, claude)` | one route, several engines |
| `engine=route` | `google_ai_mode=playwright` | one engine, its route |
| `group=route` | `llm=cli` | one route, a named set of engines — see *Engine groups* |

They mix freely in one line, and **any** of them counts as pinned, so those engines are not asked
about at Q1. The `engine=route` form is the same shape `/website-audit` uses (`offstore=serpapi`,
`llm=agent-sdk`) — including the same `llm=` group name — so a user who knows one skill can guess
the other.

**Disambiguating `x=y`:** if the left-hand side is an engine name, an engine **group**, or an alias
of either, it's a route assignment; otherwise look it up in *Key-value* below. `chatgpt=api` and
`llm=cli` are routes; `country=SA` is a key-value. An unknown left-hand side is a note on the card,
never an error.

### Engine groups — say it once for several engines

| Group | Members | Why it exists |
|---|---|---|
| `llm` · `llms` · `models` · `chat` | `chatgpt`, `claude`, `gemini` | The three engines that are actual chat models with a CLI and (mostly) an API. Users think of them as one decision — "run my LLMs on the CLI" — and that is exactly the Q1 question they'd otherwise be answering by hand. |
| `all` | all four, `google_ai_mode` included | Only meaningful with a route that can reach all four — there isn't one, so `all=<route>` is repaired per engine (below). |

> **`llm` deliberately excludes `google_ai_mode`.** It is a scraped SERP surface, not a model: no
> API, no CLI, and its own two-route ranking (`serpapi` / `playwright`). Folding it into `llm` would
> pin it to a route that cannot reach it, and the missing cell fails the submit with `MISSING_CELL`.
> So `llm=cli` pins **three** engines and leaves `google_ai_mode` to its own Q1 question — unless the
> line also pins it (`ai-mode=playwright`), which is the common pairing.

**A group distributes, then each member is repaired on its own.** `llm=cli` → `chatgpt` = `codex`,
`claude` = `claude` CLI, `gemini` = `gemini` CLI. `llm=api` → `chatgpt` = `OPENAI_API_KEY`,
`gemini` = `GEMINI_API_KEY`, and **`claude` has no API route**, so it repairs to its CLI with a
repair line: `claude: no API route in the collectors → claude CLI (same subscription, free)`.
A group never means "only the members this route can reach" — every member still gets measured.

**A group whose route reaches *none* of its members is still a pin, not a mistake to hand back.**
`llm=playwright` and `llm=serpapi` are foreseeable — those are the `google_ai_mode` routes, and users
pair them with the wrong group. Do **not** treat the token as nonsense and re-open the Q1 route
question for all three: expand the group, then walk each member through the ranking independently
(they can land on different routes), and write one repair line each:

```
chatgpt: playwright can't reach chatgpt → codex CLI
claude:  playwright can't reach claude  → claude CLI
gemini:  playwright can't reach gemini  → gemini CLI
```

The user said "pin these three"; the only thing you're repairing is *which* route, and `claude`
having no rank-2 makes that a setup question for that engine, never a reason to unpin it. The mirror
case is handled the same way: `all=cli` keeps `google_ai_mode` pinned and repairs it to `serpapi`,
since `cli` can't reach it.

**A later, more specific token wins.** `llm=cli gemini=api` is a normal thing to write: the group
sets the default, the single engine overrides it. Apply groups first, then individual engines.

**Be generous with misspellings.** `playwrite`, `playwrire`, `playwwire`, `playwwight`, `palywright` → `playwright`;
`serpapi`/`serp-api`/`serpAPI` → `serpapi`; `agent-skd` → `agent-sdk`; `googleaimode` /
`google-ai-mode` / `ai-mode` / `aimode` / `google ai mode` → `google_ai_mode`; `llms`/`LLM` → `llm`. Match case-insensitively, ignore `-`/`_`
differences, and accept anything within an obvious typo of a known token. Silently correcting a
route name is fine and needs no repair line — the user's intent is unambiguous. Only a token you
genuinely cannot resolve becomes a note.

---

## Tokens

| Token | Accepted forms | Notes |
|---|---|---|
| **domain** | `kbeautyarabia.com`, `store.myshopify.com`, `https://kbeautyarabia.com/` | Any position. Strip scheme, path, trailing slash, `www.`. This one string threads through every later call — see *Snapshots* in SKILL.md. |
| **lane** | `byok` (default) · `backend` \| `server` \| `lane-a` | `backend` skips P3–P5 entirely. |
| **route** | see *Routes* below | Applies to the engines in its parentheses. Bare `route` with no parens = "use this for every engine it can reach". |
| **engine** | `chatgpt` \| `gpt` \| `openai` · `claude` · `gemini` · `google-ai-mode` \| `google_ai_mode` \| `ai-mode` \| `ai_mode` \| `aimode` \| `google` · `all` | `all` inside a route means every engine that route can legally reach. |
| **group** | `llm` \| `llms` \| `models` \| `chat` → the three model engines · `all` → all four | See *Engine groups* below. A group is usable anywhere an engine name is. |
| **engine\|group=route** | `google_ai_mode=playwright`, `chatgpt=api`, `llm=cli` | The inverse of `route(engine)`. Same effect: those engines are pinned and skip their Q1 question. |
| **key=value** | `country=` `lang=` `city=` `product=` `intents=` `audit=` `model=` | See *Key-value* below. |
| **flags** | `yes` · `resume` · `dry-run` | Bare words, no value. |

### Routes

| Token | Alias for | Reaches |
|---|---|---|
| `cli` · `agent-sdk` · `agent` · `codex` · `subscription` | **the CLI method** — an umbrella, not one script: whatever runs headless on the user's existing plan for that engine, so don't reject `agent-sdk(chatgpt)` because `collect-agent-sdk.mjs` is Claude-only | `chatgpt` → `codex` CLI · `claude` → `claude` CLI, Agent SDK as an alternative · `gemini` → `gemini` CLI (OAuth works when GOOGLE_CLOUD_PROJECT is set; otherwise API-key auth) |
| `playwright` · `pw` · `browser` | the `playwright` MCP, signed-out profile | `google_ai_mode` **only** |
| `api` · `api-key` · `key` | **the API-key method** — `collect-api.mjs` | `chatgpt`, `gemini`. **Not `claude`** — no Claude API route exists, so `claude=api` repairs to its CLI |
| `serpapi` · `serp` | `collect-serpapi.mjs` | `google_ai_mode` only |
| `auto` | resolve by the ranking below | every engine |

> **`claude-in-chrome` / `chrome` / `cic` / `ui` are no longer routes.** They drove the user's own
> logged-in Chrome, where saved memory and custom instructions personalize the answer — the report
> then measured that account instead of the market. If one appears in the invocation, don't fail:
> repair it — a model engine → the agent lane; `google_ai_mode` → **whichever of its two routes
> ranks highest and actually works** (`serpapi` first, then `playwright` — see *`google_ai_mode` is
> ranked separately*). Write the repair line with the reason: *"claude-in-chrome retired —
> logged-in chat memory contaminates the answer"*. Same for a bare `browser` on a model engine.

### Key-value

| Key | Value | **When absent** |
|---|---|---|
| `country=` | ISO-2, e.g. `SA` | **Asked at Q1**, together with `lang=`. A domain-based guess (`…arabia.com` → SA) only orders the options — it never stands in for the answer. |
| `lang=` | ISO code, e.g. `ar` | **Asked at Q1** — never assumed. The market's local language leads the options (a non-English market measured in English ranks differently), then English. `get_shop.primaryLocale` only hints at the ordering, and is often `null`. |
| `city=` | free text, e.g. `Riyadh` | Omitted — optional in the payload. |
| `product=` | quoted title, or an `externalProductId` | **Asked at Q1** — 3–4 real titles from the catalog as options. Never invented, and never silently taken from position 1 (`/products.json` is collection-sorted, not sales-sorted). |
| `intents=` | comma list of intent slugs | Whatever `describe_check_grid`'s `intents` field returns as the default set. **Every declared intent must then be collected on all 4 engines** — the backend rejects a short grid (`INCOMPLETE_INTENT_GRID`), so this narrows the *question set*, never the engines. `where_to_buy` is always kept. |
| `audit=` | `yes` \| `no` | Ask at Q3. `audit=yes` runs it without asking; `audit=no` skips Q3. |
| `model=` | `<engine>:<id>`, comma-separated — `model=gemini:gemini-2.5-pro` | Each route uses its own default. Never asked at Q1: a model override is a workaround for a provider-side problem, not a decision the user should be handed. |

**`model=` exists because a CLI's default model can be unavailable while another is idle**, and the
CLI does not say so. Measured 2026-07-28: the `gemini` CLI's default answered a two-word prompt with
`429 MODEL_CAPACITY_EXHAUSTED` ("No capacity available for model gemini-3.5-flash",
`cloudcode-pa.googleapis.com`), then retried with backoff instead of failing — 285s of wall clock at
0% CPU, which reads as a hung network. `model=gemini:gemini-2.5-pro` returned in 9s. Reach for this
when an engine is slow rather than wrong; a real error needs a different fix.

Pass it straight through to the collector as `--model <id>` for that engine's cells only. Engines
you didn't name keep their defaults, so `model=gemini:gemini-2.5-pro` leaves `chatgpt` and `claude`
untouched. A bare `model=<id>` with no engine prefix applies to `gemini` — the only engine whose
default is known to starve — and gets a note on the confirm card saying so. An unknown engine name
is a note on the card, never an error.

Two limits worth stating: on the **API route** the grid dictates `servedModel`
(`describe_check_grid`), so overriding the model there risks `SERVED_MODEL_MISMATCH` at submit —
`model=` is for the CLI route. And a shared team account makes capacity exhaustion **more** likely,
not less, since everyone lands on the same default.

### Flags

| Flag | Effect |
|---|---|
| `yes` | Skip the Q1 confirm card and start collecting. Still print the resolved plan and every repair line first, so the record exists. **An engine the arguments left unpinned takes the ranking's pick** — with Q1 skipped there is no question left to ask, so `yes` grants the same permission `auto` does. Print those routes on the plan block and mark them `(auto)` so the user can see what was chosen on their behalf. |
| `resume` | Reuse the newest run directory for this domain instead of starting one (see RECOVERY.md). |
| `dry-run` | Stop after the confirm card. Nothing is collected, nothing is submitted, no quota spent. |
| ~~`partial-ok`~~ | **Removed — it never worked.** It promised a grid narrowed to "whatever is collectable", but the backend rejects any submission missing a platform (`INCOMPLETE_PLATFORM_GRID`), so the flag bought a full-quota run that failed at submit. If it appears in an invocation, ignore it and say why: an engine without access is fixed (login / API key) or the run moves to the backend lane. |

---

## Route priority

One ranking, applied per engine. It decides what is **pre-selected** in the Q1 route question, what
`auto` takes without asking, and where a repair lands. It does **not** authorise picking a route
silently: an engine whose route the arguments didn't pin is always asked (SKILL.md Q1). Full setup
steps live in `SETUP-ROUTES.md`.

Only two ranks remain for the model engines, because every route must be a **clean room** — a
process with no chat memory, no custom instructions and no account history (SKILL.md).

| Rank | Route | Why it wins | `chatgpt` | `claude` | `gemini` |
|---|---|---|---|---|---|
| **1** | **CLI** (vendor agent CLI / Agent SDK on a subscription) | free, parallel, fastest wall-clock, headless | `codex` CLI | `claude` CLI → Agent SDK | `gemini` CLI (OAuth when GOOGLE_CLOUD_PROJECT is set, else API key) |
| **2** | **API key** | metered for OpenAI; Gemini's free tier is genuinely free | `OPENAI_API_KEY` (paid) | — (no Claude API route here) | `GEMINI_API_KEY` (free tier) |

**A CLI that isn't logged in is not a missing route — it is a setup step.** It stays rank 1, stays
on the confirm card, and stays in the Q1 options with its login command attached (`npm i -g
@openai/codex` + `! codex login`, `/login` on the `claude` CLI, or the gemini auth switch). Drop to
rank 2 only when the user chooses the API key after seeing both. **Never drop the engine** — the
backend rejects a short grid, so there is no such thing as a cheaper partial run.

**`claude` has no rank 2.** There is no Claude API route in the collectors, so if its CLI isn't
logged in, the setup offer *is* the plan — `/login` on the `claude` CLI, or move the whole run to
the backend lane. There is no partial run to fall back on.

**Tiebreak for `gemini`.** Both of its routes spend the same AI Studio key (the CLI runs on
`GEMINI_API_KEY` too — the free OAuth tier is dead). Prefer the **agent lane** when the user wants
one uniform lane; prefer the **API key** on a large grid (≳12 cells) or when you want a real
`servedModel` — `describe_check_grid` declares `gemini.accessMethod: "api"`. Either way write the
choice on the confirm card. This tiebreak never applies to `google_ai_mode`
(`accessMethod: "scrape"`, no API exists).

### `google_ai_mode` is ranked separately

It has **no model API**, so the table above never applies. Exactly **two** legal routes — both
account-free, which is why they survived:

| Rank | Route | Cost |
|---|---|---|
| 1 | `serpapi` | free tier ≈100 searches/month; a grid spends 3–5. Server-side, no browser, parallel. |
| 2 | `playwright` | free, signed-out profile, serial. `claude mcp add playwright -- npx -y @playwright/mcp@latest` then reload the session |

Prefer whichever already works; SerpApi leads when a key is stored because it needs no session
reload and its cells fan out. Never let an agent-lane or API choice stand in for it — the cell would
simply be missing and the submit fails with `MISSING_CELL`.

---

## Repair — how a plan gets resolved

**First expand every group into its members** (`llm` → `chatgpt`, `claude`, `gemini`), then let any
single-engine token override the group's value. After that you have a flat list of
(engine, requested route) pairs — run the rest per pair. **Repair, don't reject.**

0. **Is the requested route a retired browser route** (`claude-in-chrome` / `chrome` / `cic` / `ui`,
   or `browser` on a model engine)? → drop it and continue at step 1 as if nothing was requested.
   The repair line says why: logged-in chat memory contaminates the answer.
1. **`google_ai_mode`?** → constrain to its own two routes. If the request named one of them, keep
   it. Otherwise take the highest-ranked one that works.
2. **Can the requested route reach this engine?**
   - **Yes** → is its prerequisite present (from the P1 probe)? If yes, keep it. If no, offer the
     guided setup; if the user declines, continue at step 3 as if it couldn't reach.
   - **No** → step 3.
3. **Walk the ranking** and take the first route that both reaches this engine and works on this
   machine, offering setup for a higher rank before settling for a lower one.
4. **Write a repair line** onto the confirm card, naming the reason. One line per changed engine:
   ```
   google_ai_mode: claude-in-chrome retired (logged-in chat memory skews the answer) → serpapi
   ```
5. **No route at all for an engine** → that engine goes into the coverage gap question at Q1
   as an **access-gap** question — how to get access, never whether to proceed without the engine.

Never repair silently. The confirm card exists so a repair is one glance, not a surprise in the
report.

---

## Worked examples

### Full one-shot with an impossible pair

```
/create-visibility-report kbeautyarabia.com byok \
  agent-sdk(gemini, chatgpt, claude) claude-in-chrome(google-ai-mode)
```

| Engine | Requested | Resolved |
|---|---|---|
| `claude` | agent lane | Agent SDK — kept (falls back to the `claude` CLI if the SDK isn't resolvable) |
| `chatgpt` | agent lane | `codex` CLI — the agent lane for this engine. Not logged in → guided `! codex login` first. |
| `gemini` | agent lane | `gemini` CLI — kept, but `settings.json` says `oauth-personal` (dead tier) → guided one-line switch to `gemini-api-key`; if the user declines, rank 2 `GEMINI_API_KEY` via `collect-api.mjs`. |
| `google_ai_mode` | `claude-in-chrome` | **Repaired → `serpapi`** (key stored). Retired route: a logged-in Chrome personalizes the answer. |

Confirm card: `coverage 4/4 · 15 cells · ~3 min · $0 · 2 repairs (gemini auth, google_ai_mode)`.

### Group shorthand — `llm=` plus the AI-Mode engine

```
/create-visibility-report byok kbeautyarabia.com llm=cli ai-mode=playwwight
```

| Token | Read as |
|---|---|
| `byok` | lane |
| `kbeautyarabia.com` | domain (by shape) |
| `llm=cli` | **group** → `chatgpt` = `codex` CLI, `claude` = `claude` CLI, `gemini` = `gemini` CLI |
| `ai-mode=playwwight` | `ai-mode` → `google_ai_mode`; `playwwight` → `playwright`. Two silent corrections |

All four engines pinned in two tokens, so **Q1 asks no route questions** — the confirm card still
shows the resolved route per engine plus any repair or ⚠ login line. Identical to writing
`cli(chatgpt, claude, gemini) playwright(google-ai-mode)`.

Watch what happens if a CLI isn't ready: the pin **stays**, and the card carries the setup step —
`chatgpt: codex ⚠ not logged in → ! codex login`. Pinning a route never means "use it only if it
already works", and it never licenses dropping the engine.

### Group with a per-engine override

```
/create-visibility-report acme.com llm=cli gemini=api ai-mode=serpapi
```

`llm=cli` sets all three, then `gemini=api` overrides just that one → `chatgpt` and `claude` on
their CLIs, `gemini` through `GEMINI_API_KEY` (real `servedModel`), `google_ai_mode` on SerpApi.
Specific beats general; no repair line needed, since nothing was impossible.

`llm=api` would be different: `chatgpt` and `gemini` take their keys, but `claude` has no API route,
so it repairs to its CLI with one line — `claude: no API route in the collectors → claude CLI`.

### The `engine=route` form, lane first, with a typo

```
/create-visibility-report byok kbeautyarabia.com google_ai_mode=playwrire \
  chatgpt=agent-sdk claude=agent-sdk gemini=agent-sdk country=SA
```

Everything here is a shape the grammar accepts, so nothing is rejected:

| Token | Read as |
|---|---|
| `byok` | lane — leading position is fine |
| `kbeautyarabia.com` | domain — found by shape (has a `.`, no `=`, not a keyword), not by position |
| `google_ai_mode=playwrire` | engine=route; `playwrire` → **`playwright`**, corrected silently |
| `chatgpt=` / `claude=` / `gemini=agent-sdk` | three engines pinned to the agent lane |
| `country=SA` | key-value — LHS isn't an engine, so it's looked up as a key |

All four engines are pinned, so **Q1 asks no route questions** — but the confirm card still shows
the resolved route per engine, plus any repair line. Equivalent to writing
`agent-sdk(chatgpt, claude, gemini) playwright(google-ai-mode)`.

If the Playwright MCP isn't in this session, that's a repair, not a failure:
`google_ai_mode: playwright MCP not in this session → serpapi (key stored)` — or, with no SerpApi
key either, the engine goes into the coverage-gap question with both setup paths offered.

### Minimal — everything else resolved or asked

```
/create-visibility-report kbeautyarabia.com
```
Guided. P1 fills the product picker from the storefront catalog and infers `SA`/`ar` from the
domain; `auto` ranking picks the routes; Q1 shows it all as pre-filled options.

### Backend-run, no BYOK setup at all

```
/create-visibility-report kbeautyarabia.com backend
```
Confirm card, then Lane A. P3–P5 never run.

### Fully unattended

```
/create-visibility-report kbeautyarabia.com byok auto country=SA lang=ar \
  product="COSRX Advanced Snail 96 Mucin Power Essence" audit=yes yes
```
No questions at all. The resolved plan and repair lines still get printed before collection starts.

### Plan only, spend nothing

```
/create-visibility-report kbeautyarabia.com byok auto dry-run
```

### Continue an interrupted run

```
/create-visibility-report kbeautyarabia.com resume
```
See RECOVERY.md.

---

## What is never inferred

- **A product.** Offer catalog titles and let the user pick. Never invent one, and never take
  position 1 silently.
- **A market or a language.** Both are asked when `country=`/`lang=` are absent — a domain guess and
  a local-language default only order the options. Language changes the ranking, not the wording.

The mirror of that rule: **anything the shorthand did supply is never asked again.** Pinned is
pinned — show it on the card and move on.
- **A secret.** Never fabricate a key; never echo one into the conversation.
- **`webSearchUsed`.** It reflects whether search actually ran, never what the plan hoped for.
- **A `.myshopify.com` domain.** If the user gave a storefront domain, use that string everywhere.
- **A logged-in browser as a route.** No argument revives it. Repair it and say why.
