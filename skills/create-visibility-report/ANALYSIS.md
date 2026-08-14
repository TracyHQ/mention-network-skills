# P4.5 — Analyze the answers yourself · **default ON, not an optional extra**

Read this once you've reached P4.5 in the pipeline (right after collection, right before P5
validate). It never runs for the backend lane (P3–P5 don't run there) or when the user declined
client-side analysis — don't load it earlier than you need it.

---

**This step runs on every BYOK run unless the user says otherwise.** It is the default, and the
plan you build in P4 must carry it as its own task (*"Analyze 20 cells → detection"*) sitting
between collection and validate. Measured 2026-07-28: two real runs went straight from *"collect
cells"* to *"validate, submit, poll, export"* because the todo list never contained this step —
if it isn't on the list, it doesn't happen.

**Do the merchant-mention analysis here, before validate.** You already have every answer in
`cells/`; reading them is a text task the model running this skill does for free. Supply the result
and the backend skips its own analysis LLM entirely — so the run costs the backend nothing and the
report comes back faster: measured, supplying `detection` returned `stage: done` on the **first**
poll instead of after several rounds of backend analysis.

1. **Fetch the spec — never invent the schema.** `get_detect_extraction_spec` returns the prompt
   template, the JSON schema, the guard rules, and the char limits, built from the same source the
   backend's own analyzer uses. Same principle as the prompt templates: live catalog, not memory.
   Save it to the run directory (`spec.json`) — the next two steps read it from there.
2. **Render that prompt once per cell**, filled with this run's shop, product, question, answer and
   citations. One command, no hand-assembly:
   ```bash
   node "$HERE/scripts/render-detect-prompts.mjs" \
     --cells cells/ --meta meta.json --spec spec.json --out analysis/
   ```
   It writes `analysis/<intent>.<platform>.prompt.md` per cell plus `analysis/manifest.json` (the
   JSON schema + guards + which cell each prompt belongs to), and **throws** if the spec grew a
   placeholder it can't fill — that throw is the signal the spec drifted, not a reason to improvise.
3. **Analyze each cell against its rendered prompt** — the merchants in order of first appearance,
   which one is the target shop, price/shipping whenever the answer states them, and a verbatim
   `evidence` quote per merchant — and **attach the result to the cell file** as a top-level
   `detection` field, next to `response`.

## Delegating it: one analyzer per cell, and the checker settles disputes

A full grid is 20 cells of long answers, so the analysis is normally **fanned out to sub-agents,
one cell each**. That is fine, and it is the right shape for any grid above ~8 cells — but it fails
in a specific, expensive way when the hand-off is improvised. Measured: the delegating agent
briefed the analyzers in its own words, then disagreed with what came back and re-did the
extraction by hand, cell by cell. Neither side was wrong on the facts; they were **working to two
different standards**, because only one of them was holding the backend's actual prompt. ADR-0027
is explicit that the client lane must extract with *this* prompt and *this* schema or the two lanes
stop being comparable — so a paraphrased brief is not a lighter version of the spec, it is a
different one.

Five rules, and they are what makes the delegation safe:

1. **The brief is the rendered prompt file, never your summary of it.** Give the analyzer the path
   to `analysis/<cell>.prompt.md` (step 2) and `analysis/manifest.json` for the schema. Layering
   your own guidance on top is how the standards diverge — if something in the spec is genuinely
   unclear, it is unclear for the backend's analyzer too, so fix it in `backend/`, not in a brief.
2. **One cell per analyzer, and it reads only that cell.** Merchants must not travel between cells:
   a name carried in from a neighbouring answer fails `DETECTION_UNSUPPORTED_MERCHANT` at best, and
   silently invents a mention at worst.
3. **The analyzer writes `detection` into its own cell file and returns a receipt, not the JSON.**
   A sub-agent's report is not shown to the user and gets re-typed by whoever reads it — which is
   exactly where a verbatim `evidence` quote stops being verbatim. The receipt is one line:
   file · merchant count · target flagged? · how many carry price/shipping · any warning left.
4. **The analyzer self-checks before it reports**, on its own cell, and fixes what it broke:
   ```bash
   node "$HERE/scripts/check-detections.mjs" --cells cells/<intent>.<platform>.json --fix
   ```
   `--fix` mechanically corrects `position` in place whenever it can be verified against
   `rawText` (ADR-0040) — it is not the analyzer's judgment call to get right by hand, unlike the
   merchant list, price, or shipping, which stay genuine analyst reads of the answer.
5. **When they have all landed, you run the checker over the whole set — with `--meta`:**
   ```bash
   node "$HERE/scripts/check-detections.mjs" --cells cells/ --meta meta.json --fix
   ```
   `--meta` turns on the two checks no per-cell analyzer can make, because each one only ever saw
   its own cell: **the target shop** (`WARN_TARGET_MISSED` / `WARN_TARGET_MISLABELED` /
   `WARN_TARGET_NOT_FLAGGED`) and **cross-cell agreement** (`WARN_MERCHANT_NAME_CONFLICT`,
   `WARN_MERCHANT_DOMAIN_CONFLICT`, and `WARN_TARGET_SHOP_SPLIT` — the shop's own rows split across
   two domains, which halves its rank against itself; measured on a shipped run: `glowtheory.com`
   in 12 cells, `glowtheory.co.za` in 5). Reconciling those is **yours**, not theirs — it is the
   one part of the analysis that genuinely needs the whole grid in view.

The whole brief an analyzer needs is four lines — everything else it must read for itself, which is
the point:

```
Analyze exactly one cell of a visibility grid.

1. Read <run>/analysis/where_to_buy.chatgpt.prompt.md — that is your task, in full. Follow it
   literally; it is the backend's own analyzer prompt and nothing may be added to or relaxed in it.
2. The output schema is `jsonSchema` in <run>/analysis/manifest.json, plus its `guards`.
3. Write the result into <run>/cells/where_to_buy.chatgpt.json as a top-level `detection` field,
   next to `response`. Change nothing else in that file, and read no other cell.
4. Then run: node <skill>/scripts/check-detections.mjs --cells <run>/cells/where_to_buy.chatgpt.json
   Fix what it flags, re-run until clean, and reply with ONE line:
   <file> · <n> merchants · target flagged: yes|no · <n> with price · <n> with shipping · <warnings>
```

> **The checker is the arbiter — your reading is not.** "I'd have extracted this differently" is
> not a finding; it is two plausible readings of one answer, and re-doing 20 cells by hand to
> impose yours costs a full re-analysis and still leaves a grid that matches no single standard.
> Act only on something that names itself: a `DETECTION_*` / `WARN_*` code, a merchant that is not
> in the answer at all (fabrication), a threshold booked as a fee, or the wrong shop flagged as the
> target. And when you do act, **re-dispatch that one cell** with the finding appended to its
> prompt file — never hand-patch it yourself, or the grid ends up extracted by two different
> analysts, which is the thing this section exists to prevent. Two rounds on the same cell and it
> stops: strip `detection` from **every** cell and let the backend analyze (all-or-nothing), then
> say so in the handover.
>
> **`position` is the one exception, and `--fix` is why.** It is not an interpretive field like
> merchant identity, price, or shipping — it is a pure function of where each name (or its
> evidence) first appears in `rawText`, so once the checker can verify it there is no reading left
> to defend. `--fix` rewrites it in place instead of just flagging it (ADR-0040); the
> "never hand-patch it yourself, re-dispatch instead" rule above still applies to everything else
> `DETECTION_*`/`WARN_*` can flag, just not to `position` anymore.

**`price` / `priceRaw` / `shipping` are not optional extras — they are two columns on the page the
customer reads,** and a merchant you leave null renders there as `N/A`. Do a second pass over the
`cheapest` and `free_shipping` answers specifically: those two questions all but force the answer to
quote a figure per merchant, and they are where the columns get filled. `priceRaw` is the string
**exactly as the answer wrote it** (`"AED 135"`, `"€16,40"`, `"228,89 €"`) — never reformat it, the
backend prints it verbatim. A figure the answer attaches to the *product* rather than to a seller
belongs to no merchant — leave it null. Never invent a figure or move one merchant's onto another.

**Shipping is a policy, not a sentence.** Alongside the verbatim `shipping` string, fill
`shippingPolicy`: `{ kind, feeAmount, freeOverAmount, currency }` where `kind` is `free` ·
`free_over_threshold` · `paid` · `calculated_at_checkout`. The one mistake that matters:
**a threshold is not a fee.** `"Envío gratis desde AED 199"` is `kind: "free_over_threshold"` with
`freeOverAmount: 199` — putting 199 in `feeAmount` tells the customer the exact opposite of what the
answer said, and it looks perfectly plausible on the report. `feeAmount` is for `kind: "paid"` only;
the backend rejects the mix (`DETECTION_INVALID_SHIPPING_POLICY`). And not everything about delivery
is shipping cost — `"free returns"`, `"delivery in 2–3 days"` are not a policy, leave it null.

**All-or-nothing.** Every cell gets a `detection` or none does — a mixed grid means one report built
by two different extractors, and the validator rejects it (`DETECTION_PARTIAL`).

The guards that will be checked (the spec lists them in full — these are the ones that bite):

| Rule | Why it matters |
|---|---|
| Every merchant needs **real evidence in that cell** — name in `rawText`, or domain among the citations, or a verbatim `evidence` quote containing the name | Without it the backend drops the merchant silently. Validate now returns `DETECTION_UNSUPPORTED_MERCHANT` instead, so you fix it before spending a submit |
| `isTargetShop` on **exactly one** merchant | `DETECTION_MULTIPLE_TARGETS` |
| `position` = order of first appearance, `1..n`, no duplicates | The report's `bestRank` reads straight from it — wrong order is a wrong number on the customer's report |
| `mentionSources` non-empty (`text`, `citation`, or both) | `DETECTION_MISSING_SOURCE` |
| Don't add the target shop just because the product is discussed | A product mention is not a merchant mention. The shop context is for recognition only |
| A `cheapest` / `free_shipping` answer that quotes money must leave **some** merchant carrying `price` / `shipping` | `NO_PRICE_EXTRACTED` / `NO_SHIPPING_EXTRACTED`. These are **warnings, not errors** — they never block submit and the report is still correct on rank/score, but ignoring them ships the PRICE/SHIPPING columns as `N/A` |

## Self-check the guards before you submit — and get the evidence rule right

Run `node "$HERE/scripts/check-detections.mjs" --cells cells/ --meta meta.json --fix` after
writing detections and before `submit.mjs`, so a bad one costs a second instead of a validate
round-trip. `--fix` mechanically corrects `position` wherever it can be verified against
`rawText` (ADR-0040) — don't hand-fix a position violation, let the flag do it and re-run.
(Pass `--meta` whenever you have it — without it the target-shop and cross-cell agreement checks
above are simply skipped, and the tool says so on its last line.) It mirrors the
`DETECTION_*` codes below locally (still an approximation — `validate_byok_submission` stays the
authority) and also warns on an evidence quote over 160 chars and a `mentionSources: ['citation']`
claim whose domain isn't actually in that cell's citations. **The rule that is easy to implement
wrongly**, and the one `check-detections.mjs` gets right so you don't have to re-derive it:

```js
// WRONG — every evidence quote you copied is verbatim, so this always passes and checks nothing
const supported = raw.includes(m.evidence)
// RIGHT — support means the NAME is findable, fold-matched the same way the backend matches it
// (diacritics folded, every script's letters/numbers kept — not just a plain lowercase compare)
const supported = fuzzMatches(raw, m.name)
             || fuzzMatches(m.evidence, m.name)
             || citeDomains.some((d) => d === m.domain)
```

Also assert `position` is `1..n` with no gaps and in true first-appearance order (`--fix` does
this for you), at most one `isTargetShop`, `evidence.length <= 160`, and that `mentionSources`
never claims `citation` unless the domain really is in that cell's citations. Measured
2026-07-28: the wrong version above passed a merchant the backend then rejected.

## One thing that bites on non-English markets

- **Give each merchant the domain *that cell* actually cited.** One brand often runs several
  (`sephora.me` **and** `sephora.sa`; both were cited by different engines in one run). Dedup is on
  domain, so this does split one brand across two report rows — accept the split. Forcing a single
  domain onto a cell that cited the other one makes `mentionSources: ['citation']` a false claim,
  which is worse than a duplicate row.

> Non-Latin merchant names (Arabic, Japanese, Korean, …) submit normally now — the backend's
> support check (and this file's `isSupported`) fold diacritics and keep every script's own
> letters/numbers, not just `[a-z0-9]`/`\w`. Fixed backend-side in `c3781fb6` (2026-07-29); no
> special handling or Latin-spelling workaround is needed for a merchant named only in local
> script anymore.

## When it is legitimate to skip — and how to say so

Omitting `detection` everywhere is a valid fallback, but it is a **decision you announce**, never a
quiet omission. Only these count as reasons:

- **The user asked for it** — they want the backend's own extractor to be the interpreter.
- **The guards can't be satisfied honestly** for some merchant, and dropping it would misrepresent
  the answer (e.g. a merchant with no real evidence in the cell — see `DETECTION_UNSUPPORTED_MERCHANT`
  in RECOVERY.md).
- **Two repair rounds on `DETECTION_*` failed.** Strip `detection` from every cell (all-or-nothing)
  and let the backend analyze rather than burn a third round.

"It's faster to skip it" is not on that list. Everything downstream is identical either way; only
the `source` differs (`byok` vs `byok_client_analysis`), because supplying the analysis means
supplying the interpretation too, and the disclosure has to say so.
