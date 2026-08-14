# Recovery — the run directory, `resume`, and every error → its fix

Read this when something fails, or when the invocation carries `resume`. The rule that governs the
whole file:

> **Auto-fix up to two rounds, then ask.** A retryable failure is yours to handle silently. A
> failure that survives two honest attempts becomes one `AskUserQuestion` with concrete options —
> never a wall of stack trace, never a silent drop, never a fabricated value.

---

## The run directory

Every BYOK run gets a directory so an interrupted session loses nothing. Create it at the start of
P4, in the user's working directory:

```
.mn-runs/<shopDomain>/<YYYY-MM-DDTHHMM>/
├── state.json      the resolved plan + per-cell status  (you maintain this)
├── prompts.md      the approved prompt table from Q2    (the record of what was asked)
├── meta.json       submit payload metadata — OUTSIDE cells/
├── spec.json       get_detect_extraction_spec, as fetched (P4.5 renders the analysis from it)
├── analysis/       one <cell>.prompt.md per cell + manifest.json — the analyzers' brief
├── cells/          one <intent>.<platform>.json per cell — nothing else in here
└── out/            exported or locally rendered PDFs
```

`submit.mjs` reads **every** `*.json` in `cells/` as a cell — keep `meta.json` and `state.json` out
of it or the submit fails.

`state.json`:

```json
{
  "shopDomain": "kbeautyarabia.com",
  "lane": "byok",
  "meta": { "locationCountry": "SA", "language": "ar", "product": "…" },
  "routes": { "chatgpt": "cli:codex", "claude": "agent-sdk", "gemini": "cli:gemini", "google_ai_mode": "serpapi" },
  "grid": [{ "intent": "where_to_buy", "platform": "chatgpt", "status": "done" }],
  "checkRunId": null,
  "reportId": null
}
```

`status` per cell: `pending` → `running` → `done` | `failed:<reason>`. Write it after each cell
finishes, not at the end — that's the whole point.

> **Write `state.json` even when the run is going well.** It is tempting to skip it while cells are
> landing cleanly and "add it at the end" — measured 2026-07, a full run finished with no
> `state.json` at all, which would have made an interruption at minute 18 unrecoverable. The file
> costs one write per cell; the whole point is that you cannot know in advance which run gets cut
> off. Write `checkRunId` and `reportId` the moment each exists, too.

## `resume`

1. Take the newest directory under `.mn-runs/<shopDomain>/`. Say which one, and how old it is.
2. Read `state.json`. If `reportId` is set → jump straight to **P7** (export and show the link).
   If `checkRunId` is set → jump to the **P6 poll**. Otherwise continue collecting.
3. Re-collect only cells that aren't `done`. Cells already on disk are reused as-is — the prompt
   text is fixed in `prompts.md`, so a mixed-age cell set is still consistent.
4. Skip Q1 and Q2 — they were already answered. Show a one-line summary of what's being resumed
   and what's left instead.
5. **No run directory found?** Say so plainly and start a fresh guided run.

---

## Preflight and access errors

| Symptom | Fix |
|---|---|
| MCP tools not present in the session | The user hasn't installed/keyed it. Give the `claude mcp add` one-liner (SKILL.md P1) and stop until a tool actually answers. Adding an MCP needs a session reload before the tools appear — say that. |
| **`MENTION_NETWORK_KEY: missing` and no host tool answers** — the first-run case | **Not recoverable by falling back**: the prompt templates, intents, grid and validator all live behind the MCP, so no lane can run without it. Stop **before** the confirm card, point the user at mention.network for a key, and offer to store it: `MENTION_NETWORK_KEY='<pasted>' node "$HERE/scripts/credentials.mjs" save MENTION_NETWORK_KEY`. Then re-probe and resume at P1. Never paper over it with an `UNKNOWN` coverage line. |
| MCP call returns **401 / invalid key** | The key is wrong or expired, not missing. Ask for a fresh one from mention.network and offer to `save` it. Don't retry the same key. |
| MCP call **times out / network error** | Retry once. Still failing → report it as an outage; offer `dry-run` so the user's answers aren't wasted. |
| `ERR_AMBIGUOUS_MODULE_SYNTAX` from a `node --input-type=module -e` snippet | You mixed `require()` into a snippet that already uses top-level `await`. The `mcp-client.mjs` snippets are ESM — use `import { readFileSync } from 'node:fs'` at the top, never `require`. |
| `SHOP_NOT_FOUND` from `get_shop` | **Not an error.** The store has never been checked. Build the snapshots from what the user gives. |
| `list_shop_products` returns 0–1 products | Normal — it only shows what the backend already upserted (measured: 1 product for a store with a full catalog). Fall through to the storefront catalog. |
| `GET /<domain>/products.json` → 404 or non-JSON | The storefront disabled it. Fall back to `list_shop_products`, then to a typed title. |
| `products.json` → **503 / throttled** | Back off once and retry. Still throttled → same fallback chain; don't hammer it. |
| Domain unreachable at all | Likely a typo. Say what you tried, suggest the correction, and ask — don't proceed against a guess. |

---

## Collection failures

Handle per cell. One bad cell must never sink the batch — collect the rest, then come back.

| Symptom | Round 1 | Round 2 | Then ask |
|---|---|---|---|
| `429` / quota | Back off (respect `Retry-After`) and retry that cell | Lower the pool for that route and retry | Switch this engine to its other method (CLI ↔ API key). **Not** dropping the cell — every declared cell must exist |
| `503` / `5xx` | Retry with backoff — the collectors already do this (measured: Gemini `503`) | Retry once more | Next-ranked route |
| CLI not found / not authed | Hand the user the exact login line (`! codex login`, `/login`) — this is a setup step, not a dead route | Re-probe after they confirm | Offer that engine's API key; `claude` has none, so the only alternative is the **backend lane**. **Never drop the engine** — a short grid is rejected at submit |
| `gemini` CLI: **`IneligibleTierError`** | Not a login problem — the free `oauth-personal` tier is dead. Switch `~/.gemini/settings.json` to `security.auth.selectedType: "gemini-api-key"` with `GEMINI_API_KEY` (`SETUP-ROUTES.md`) | Re-run the cell | `collect-api.mjs --provider gemini` on the same key |
| `gemini` CLI: "not running in a trusted directory" | The collector passes `--skip-trust`; if you invoked `gemini` by hand, add it (or `GEMINI_CLI_TRUST_WORKSPACE=true`) | Re-run | — |
| Agent SDK not resolvable | Fall back to `collect-cli.mjs --engine claude` on the same subscription | — | Don't `npm install` mid-run to unblock a report |
| CLI flag rejected | Read `--help` on the *installed* version — flags drift; the collectors encode the 2026-07 forms | Adjust and retry | Next-ranked route |
| **Your own orchestrating call got killed before the collector finished** — e.g. you ran `collect-pool.mjs`/`collect-cli.mjs` as a plain foreground shell call and it hit *your tool's* default execution timeout (often ~2 min), not the collector's own `--timeout-ms` | **Not a route failure — you under-timed the wrapper, not the collector.** Re-run with real wall-clock room: pass an explicit long `timeout` (e.g. 300000ms) on that call, or run it truly in the background and poll. Re-run only the cells still missing — write an `existsSync` skip-guard into the grid file rather than redoing finished cells | — | — (this always resolves once timed correctly; it is never a reason to switch routes, and retrying the exact same short-timeout call again just repeats the loop) |
| The collector itself reports timing out (`--timeout-ms` fired, default 180s) | Raise `--timeout-ms` once and re-run that cell | — | **Next-ranked route — silently, only if its key is already stored.** `gemini`: switch to `collect-api.mjs --provider gemini` on the same `GEMINI_API_KEY` (identical AI Studio quota as the CLI, so this costs nothing extra — safe to do without asking). `chatgpt`: `OPENAI_API_KEY` is metered and, unless already stored, offer it rather than spend it unasked. `claude`: no API route exists — the only alternative is the backend lane |
| Playwright: AI Mode pane never rendered | The `udm=50` URL fell back to a plain SERP — re-navigate once and re-check before reading | Re-run the cell | SerpApi for that cell |
| Playwright: Google bot check / CAPTCHA | Wait and re-navigate on the same signed-out profile | Collect that cell via SerpApi | **Never solve a CAPTCHA, and never switch to the user's logged-in Chrome to get past it** |
| Playwright: answer empty / truncated | Read mid-stream — poll until the text stops growing, then read once | Re-run the cell | SerpApi |
| **Playwright: `Browser is already in use for …/mcp-chrome-<id>, use --isolated`** | A live Chrome holds that profile, and **`browser_close` fails the same way** — you cannot clear it from inside the MCP, and you must not kill it unasked (it may be the user's other work). Find the owner: `ps aux \| grep mcp-chrome-<id>` | **Ask** — kill that PID, let the user close it, or take SerpApi for `google_ai_mode`. Only on their word: `kill <pid>`, then `rm` the stale `Singleton{Lock,Cookie,Socket}` symlinks in the profile dir | Not a route failure — `google_ai_mode` still has SerpApi, which needs no browser at all |
| Playwright: answer captured but it's the **source list**, not the prose | The "smallest element > 400 chars" heuristic grabs the citations block. Read `document.body.innerText` and trim it (`COLLECT-PLAYWRIGHT.md`) | Re-extract from the same page — no need to re-navigate | — |
| Playwright: citations block still glued to the answer | The cut regex didn't match: the header is **localized** (`N مواقع إلكترونية`, not `N sites`) and `\b` never matches after non-Latin letters | Use `/\d+\s*(?:مواقع\|sites)/` with **no** `\b` | — |
| Web search didn't run | Re-run the cell; every collector forces search on, so this usually means a transient failure | Switch that engine to its other clean-room route | **Never set `webSearchUsed: true` to get past it** |
| The user asks for a logged-in browser route | Explain the memory contamination (SKILL.md *Clean-room collection*) and offer the agent-lane setup | If they insist, it is their call | Disclose in the handover that those cells came from a personalized account |

---

## Validator errors → fix

`node "$HERE/scripts/submit.mjs" --cells cells/ --validate-only` prints these. Fix and re-run until
clean; only involve the user if the same code survives two rounds.

**These codes cover the cells only.** `validate_byok_submission` never reads `meta.json`, so a clean
`ok: true, validatedCells: N` still leaves the shop/product snapshot unchecked — that is enforced by
`submit_byok_check`'s own input schema, which fails with a raw zod error instead of a code. See
*Submit, poll, export* below.

| Code | What it means | Fix without asking |
|---|---|---|
| `INCOMPLETE_PLATFORM_GRID` | The submission is missing one of the 4 platforms | **There is no fix at submit time** — the grid is fixed and a 3-engine report is not a thing the backend will store. Get access for that engine (login / API key, `SETUP-ROUTES.md`), collect its cells, resubmit. If the user won't, the run has to move to the backend lane. Prevent it at Q1: never offer to drop an engine |
| `INCOMPLETE_INTENT_GRID` | A declared intent is missing on some platform | Same shape as above — collect the missing cells. Every intent you declare must exist on **all 4** platforms |
| `MISSING_CELL` | A declared (platform × intent) has no cell | Re-collect exactly that cell. **Narrowing the grid is not a fix** — dropping a platform just trades this for `INCOMPLETE_PLATFORM_GRID` |
| `MISSING_WHERE_TO_BUY` | The mandatory intent was edited out | Restore it and re-render the prompt set |
| `INCONSISTENT_PROMPT_TEXT` | The same intent has different text across platforms | Re-render every cell of that intent from `prompts.md` — one prompt per intent, identical across platforms |
| `WEB_SEARCH_REQUIRED` | A cell claims no web search | Re-collect with search on. Citations are **not** required (the free Gemini UI often returns none) |
| `UNEXPECTED_SERVED_MODEL` | A `browser` cell carries a `servedModel` | Strip it. Browser cells have an empty `servedModel` for **every** engine — `get_byok_skill`'s own `google_ai_mode` section says the same; the validator wins |
| `SERVED_MODEL_MISMATCH` | An `api` cell's model isn't the grid's `apiModelId` | Take the exact `apiModelId` from `describe_check_grid` and re-collect. Never hardcode a model id |

### When you analyzed the answers yourself (P4.5)

These appear only if cells carry a `detection` field. Every one is fixable by editing the
`detection` — never by re-collecting the answer, which costs quota for nothing.
`node "$HERE/scripts/check-detections.mjs" --cells cells/ --fix` catches most of these locally
before you spend a `validate_byok_submission` round-trip on them (`--fix` mechanically corrects
`position` in place, see the `DETECTION_BAD_POSITIONS` row below).

| Code | What it means | Fix without asking |
|---|---|---|
| `DETECTION_PARTIAL` | Some cells have `detection`, others don't | Analyze the remaining cells, or strip the field from all of them. A mixed grid is one report built by two extractors |
| `DETECTION_UNSUPPORTED_MERCHANT` | A merchant has no evidence in that cell — the backend would drop it silently | Re-read that cell: use the name the answer actually wrote, add the domain if it's among the citations, or make `evidence` a real verbatim quote containing the name. If the merchant genuinely isn't in the answer, remove it. **Never** invent a name the answer didn't write just to pass. (Non-Latin script names — Arabic, Japanese, Korean, … — match normally; the backend's support check and this file's `isSupported` both fold diacritics and keep every script's own letters/numbers, fixed backend-side in `c3781fb6`, 2026-07-29.) |
| `DETECTION_MULTIPLE_TARGETS` | More than one merchant flagged `isTargetShop` | Merge into one entry — the target appearing under two names or domains is still one shop |
| `DETECTION_BAD_POSITIONS` | `position` isn't `1..n` distinct, **or** it IS a valid `1..n` set but out of first-appearance order in `rawText` (#287 upgrade, hardened further in ADR-0040) | Run `check-detections.mjs --fix` — it recomputes the correct order itself (fold-matching a diacritic or markdown-escaped name like `Yahoo\!ショッピング`, falling back to the evidence quote's own offset) and **rewrites `position` in the cell file for you**, printing `FIX <file>: "<name>" position <old> → <new>` per merchant it touched. Only a cell where some merchant can't be located at all (citation-only, no textual presence) is left for you to check by hand. This drives `bestRank` on the customer's report — real incident: an analyzer sorted by "recommendation strength" instead of appearance, printing the wrong #1 |
| `DETECTION_MISSING_SOURCE` | A merchant has no `mentionSources` | `text` if named in prose, `citation` if it appears via a cited URL, both if both |
| `DETECTION_EMPTY_NAME` | A merchant has a blank name | Use the site/brand name — never a product-page title |
| `DETECTION_INVALID_SHIPPING_POLICY` | A number sits under a `shippingPolicy.kind` that doesn't explain it — almost always a free-over **threshold** filed as a **fee** | Move it: `"free over $40"` is `kind: "free_over_threshold"` + `freeOverAmount: 40`. `feeAmount` is for `kind: "paid"` only. This one is an error rather than a warning because the two read as opposites on the customer's report while both look plausible |

**Warnings, not errors.** `validate_byok_submission` returns these in a separate `warnings` array
(`submit.mjs` prints them as `WARN …`). They never block submit and the report stays correct on
rank, score and coverage — but each one you ignore is a column of `N/A` on the page the customer
reads.

**They report a fact, not a cause.** The fact is "no valid value was extracted here". `N/A` in those
columns has had three different causes: the answer genuinely naming no figure, retrieval handing
back a different answer, and a normalizer at the read layer discarding values the database held
correctly. Two of the three were once "fixed" at the wrong layer because the symptom got read as a
diagnosis. Audit the cell, then decide — leaving it null is the right answer when the answer really
attaches no figure to that merchant.

| Code | What it means | What to do |
|---|---|---|
| `NO_PRICE_EXTRACTED` | Either no merchant in the whole grid carries a price, or one `cheapest` cell whose answer quotes money produced none | Check whether the figure is actually tied to a merchant — a product-level price ("it retails around €30") belongs to no one and stays null. If it is tied, fill `priceRaw` **verbatim** (`"AED 135"`, `"228,89 €"` — never reformat) plus `price` when the currency is unambiguous. Never copy one merchant's figure onto another |
| `NO_SHIPPING_EXTRACTED` | Same, for `shipping` on the `free_shipping` intent | Fill it only with a real shipping condition — `"Free"`, `"Free over $40"`, `"AED 20"`. `"free returns"` and `"delivery 2–3 days"` are **not** shipping cost, and a free-over threshold must never be reduced to its bare number (`"Envío gratis desde AED 199"` once surfaced as a 199 shipping fee — the opposite of what it says) |

### Local-only warnings — the ones a per-cell analyzer cannot see

`check-detections.mjs --cells cells/ --meta meta.json` adds these; the backend has no code for
them. They exist because P4.5 is fanned out one analyzer per cell, so nothing inside the analysis
can notice that *this* cell disagrees with the other nineteen. Without `--meta` they are silently
skipped (the tool prints a note saying so on its last line).

| Code | What it means | What to do |
|---|---|---|
| `WARN_TARGET_MISSED` | The answer names the target shop (its domain, or its name) but no merchant in that cell carries `isTargetShop` | Re-read the cell. Named as a place to buy → it belongs in `merchants`, flagged. Only the product or the brand discussed → the warning is correct to ignore, that is exactly the "a product mention is not a merchant mention" rule |
| `WARN_TARGET_NOT_FLAGGED` | The target shop **is** in `merchants`, just not flagged | Set `isTargetShop: true` on it. The report's own-shop rank reads from this flag alone, so an unflagged cell silently drops the shop out of its own report |
| `WARN_TARGET_MISLABELED` | `isTargetShop` sits on a merchant matching neither the shop name/aliases nor its domain | Move the flag. A marketplace that happens to sell the product is never the target |
| `WARN_TARGET_SHOP_SPLIT` | The target shop appears under two domains across cells (`glowtheory.com` in 12 cells, `glowtheory.co.za` in 5 — measured on a shipped run) | Reconcile to the shop's real domain **where the cell supports it**. Dedup is on domain, so a split ships the shop as two rows and halves its own rank. If one engine genuinely only ever cited the other domain, keep it and say so — but never leave the domain null to dodge the choice |
| `WARN_MERCHANT_NAME_CONFLICT` | One domain named several ways (`"iHerb"` vs `"iHerb South Africa"`) | Pick one spelling — the one the answers use most — and rewrite the others. Whichever wins becomes the label on the report row |
| `WARN_MERCHANT_DOMAIN_CONFLICT` | One name split across domains (`sephora.me` vs `sephora.sa`) | Legitimate when each cell really cited its own domain (`ANALYSIS.md` accepts that split). Not legitimate when one of them was inferred — fix the inferred one |
| `WARN_MERCHANT_NORMALIZED_DUP` (#287, R4) | Two spellings fold to the same store once whitespace / `の`・`・`・`ー` / a `本店`・`支店`・`店` branch suffix are stripped, yet carry different name **and** different (or null) domain — the case `WARN_MERCHANT_NAME_CONFLICT`/`WARN_MERCHANT_DOMAIN_CONFLICT` both miss because neither the name nor the domain matches exactly. Real incident: `"熊野筆の北斗園"` (domain `store.shopping.yahoo.co.jp`) vs `"熊野筆 北斗園"` (domain empty) — one store, split into two 10% report rows instead of one 20% row | Reconcile to one name and one domain across the cells that mention it — same fix shape as the two codes above, just caught by a looser key |
| `WARN_MERCHANT_MISSED_IN_CELL` (#287, R1) | A merchant name extracted in ANOTHER cell of this grid appears verbatim in THIS cell's own `rawText` too, but this cell's `detection` doesn't carry it | Re-read this cell (or re-dispatch it): if the name really is a merchant mention here, add it. Measured on the source incident: 11 merchants missed this way across the grid, one cell alone missing 3 of 13 (~23%). Only catches names extracted *somewhere* in the grid — a name never extracted anywhere (e.g. buried in one shared sentence with two others, only one of which got picked up) still has to be found by eye |

**Guard against agent-lane leakage — not detection-gated, always runs:**

| Code | What it means | What to do |
|---|---|---|
| `AGENT_LANE_CONTAMINATION` (#287, R5) | `rawText` matches a tool-permission refusal / meta-commentary pattern about the collection run itself (`WebFetch`, `web_search`, `permission`, `denied`, `を許可いただければ`, `search results only`) — not a shopper's answer. Runs on every cell regardless of whether it carries `detection`, and mirrors the same regex `validate_byok_submission` enforces server-side (`byok-validate.util.ts`) | Re-collect that cell. Real incident: a `cheapest × claude` cell opened with *"WebFetch was denied, so I couldn't open product pages for live prices — the answer below is from search results only"* and closed in Japanese asking to be granted `WebFetch` — an agent-CLI tool-permission message, scored and printed in the Appendix as if it were the AI's answer |

**Fix these by re-dispatching the affected cell, not by hand-editing it** (`ANALYSIS.md`,
"Delegating it"). A grid extracted by one analyzer plus your corrections is a grid extracted by two.

---

## Submit, poll, export

| Symptom | Fix |
|---|---|
| `Input validation error: Invalid arguments for tool submit_byok_check` | The **meta**, not the cells — a raw zod error naming the bad path. Read `path` and fix `meta.json`; the validator will never flag it. Measured: `["product","price"]` *expected number, received string*, because the storefront catalog gives `"109.00"`. Coerce with `Number(...)`, or drop the optional field. |
| `submit` returns `deduped: true` | An earlier run with that `idempotencyKey` was returned — **no new report**. Explain it, then offer a fresh run (`submit.mjs` generates a new key each call; a key in `meta.json` overrides that — remove it). |
| Poll never reaches `stage: done` | Read the **top-level** `stage`/`status`, not the per-engine states: an engine you didn't submit stays `queued` forever. |
| Poll exceeds ~3 minutes (15 × 12s) | Don't hang. Print the `checkRunId`, save it to `state.json`, and give the user the `resume` line. |
| Run finishes `failed` | Report it as failed with whatever reason the status carries. **Never present a partial or failed run as done.** |
| `export_visibility_report_pdf` fails | Retry once, then fall back to the local renderer: assemble `report.json` (`{ meta, visibility, audit }`) and run `node "$PACK/shared/render.mjs" --data report.json --out out/<domain>-<date>.pdf` (needs Node ≥18 + Chrome). Wrap `get_visibility_report`'s output as the **`visibility`** key — it is not the whole file. |
| `export_visibility_report_pdf` → **"Lỗi nội bộ khi xử lý tool"** | A server-side 500, not your payload — the `reportId` is fine and the report exists. Don't re-submit the run (spends quota for nothing, and dedupes anyway). **It is often transient: the same `reportId` that failed twice succeeded ~15 min later with `cached: false`** (i.e. it generated fresh), measured 2026-07-28. So: retry, wait, retry again before declaring it down; render locally meanwhile so the user isn't blocked. |
| Diagnosing that 500 — **do not compare against a cached report** | The response carries a **`cached`** flag, and a `cached: true` call never touches the generation path at all. Comparing a cached report against uncached ones makes any difference between them (language, lane, age) look causal when the only real variable was cache-hit. Measured 2026-07-28: `ar` reports failed while an `en` one "worked" — but the `en` one was `cached: true`, and every `ar` report exported fine once generation recovered. **Control for it:** pick a report that has never been exported, or read `cached` on every call before drawing a conclusion. |
| Local renderer: `Cannot read properties of undefined (reading 'toFixed')` | Field drift between the report API and `shared/render.mjs`. **Fixed 2026-07-28** — the renderer now accepts both `visibilityScorePct`/`avgRank` (live) and `sovPct`/`rank`/`bestRank` (older, and what the test fixtures use). If it resurfaces, a new field was renamed: remap it in `normalizeVisibility` and add a case to `shared/tests/normalize.test.mjs` rather than remapping inside the run. |
| Local renderer fails too | Hand back the report data and the `reportId` — the deliverable still exists server-side. |
| Audit polling stalls | Same rule as the visibility poll: print the `auditId` and stop. The visibility PDF from P7 is already delivered and stands on its own. |
