// Re-check the P4.5 `detection` guards locally, on the cells the agent just wrote — so a bad
// merchant costs a second here instead of a validate_byok_submission round-trip (SKILL.md P4.5
// "Self-check the guards before you submit"). Mirrors the DETECTION_* codes in RECOVERY.md; this
// is a local approximation, not a substitute for validate_byok_submission, which stays the
// authority (its schema can drift — see get_detect_extraction_spec).
//
// Usage:
//   node check-detections.mjs --cells cells/ [--meta meta.json]
//
// `--meta` is optional but worth passing when the analysis was fanned out: it enables the two
// checks a per-cell analyzer cannot make — did this cell miss the target shop, and did the cells
// agree with each other about who each merchant is. Those are exactly the findings that otherwise
// come back as "the delegating agent disagrees with the sub-agent", i.e. as an opinion instead of
// a code.
//
// Exits 0 (all clean or no cell carries `detection` — that's a valid choice, see SKILL.md "When
// it is legitimate to skip"), or 1 with every violation printed, one line per cell.

import { readFileSync, readdirSync, statSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Same symlink trap as submit.mjs (.claude/skills/* resolves through a symlink) — see its comment.
function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(moduleUrl)
  } catch {
    return false
  }
}

export function parseArgs(argv) {
  const out = { cells: null, meta: null, fix: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    const rawKey = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (rawKey === 'fix') {
      out.fix = true
      continue
    }
    if (rawKey !== 'cells' && rawKey !== 'meta') continue
    let val
    if (eq !== -1) val = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i]
    if (val !== undefined) out[rawKey] = val
  }
  return out
}

// Loads every *.json in a dir, tagged with its filename so violations can point back at it.
// `path` is the full path it was actually read from — `--fix` writes back there.
export function loadCellFiles(path) {
  const st = statSync(path)
  const files = st.isDirectory()
    ? readdirSync(path).filter((f) => f.endsWith('.json')).sort()
    : [path]
  const base = st.isDirectory() ? path : ''
  return files.map((f) => {
    const fullPath = st.isDirectory() ? join(base, f) : f
    return {
      file: st.isDirectory() ? f : path,
      path: fullPath,
      cell: JSON.parse(readFileSync(fullPath, 'utf8')),
    }
  })
}

// ── Fold dấu + fuzzy matching — ported from backend, plain JS, same algorithm/thresholds ──────
// Keep in sync with backend/src/shared/utils/fold-diacritics.util.ts (foldDiacriticsChar /
// foldDiacritics) and backend/src/modules/shop-detect/utils/mention-count.util.ts (fuzz /
// minFuzzLength / fuzzyFirstIndex) — same convention as answerStatesMoney /
// AGENT_LANE_CONTAMINATION_PATTERN above: change one side, change the other.

// Combining marks U+0300-U+036F (NFD decompose) — written as a \u escape, not a literal glyph.
const COMBINING_MARKS = /[\u0300-\u036f]/g
const EXTRA_FOLD_MAP = { đ: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l' }

export function foldDiacriticsChar(ch) {
  const folded = ch.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '')
  return EXTRA_FOLD_MAP[folded] ?? folded
}

export function foldDiacritics(input) {
  let out = ''
  for (const ch of String(input ?? '')) out += foldDiacriticsChar(ch)
  return out
}

export function fuzz(s) {
  return foldDiacritics(s).replace(/[^\p{L}\p{N}]+/gu, '')
}

// 3 chars for Latin, 2 for CJK/Kana/Hangul — each character there is a full morpheme (Coupang
// "쿠팡", Rakuten "楽天" are complete brand names at 2 chars); requiring 3 would drop most
// Japanese/Korean brands from the competitor table.
const CJK_LIKE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

export function minFuzzLength(fuzzed) {
  return CJK_LIKE.test(fuzzed) ? 2 : 3
}

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u

// Folds `s` char-by-char (one input char can expand to several output chars, e.g. 'ß' → 'ss'),
// keeping — for every RETAINED output char — the original char's index (UTF-16 code unit,
// matching String.indexOf) that produced it. This is what makes `fuzzyFirstIndex` return a real
// offset into the UNFOLDED haystack instead of an offset into the folded string.
function foldWithOriginIndex(s) {
  let expanded = ''
  const expandedOrigin = []
  let pos = 0
  for (const ch of s) {
    const folded = foldDiacriticsChar(ch)
    for (const oc of folded) {
      expanded += oc
      expandedOrigin.push(pos)
    }
    pos += ch.length
  }
  let folded = ''
  const origin = []
  for (let i = 0; i < expanded.length; i++) {
    if (LETTER_OR_NUMBER.test(expanded[i])) {
      folded += expanded[i]
      origin.push(expandedOrigin[i])
    }
  }
  return { folded, origin }
}

// R3 (#287, C2) upgrade: `fuzz()` was only ever a boolean `.includes()` check — fold-then-cut-to-
// substring throws away the original character offsets. This is the new primitive: fold both
// sides the same way `fuzz()` does, but keep enough bookkeeping to map the match back to a real
// offset in the UNFOLDED haystack. Returns -1 when `needle` (folded) doesn't clear
// `minFuzzLength` — "cannot reliably locate", not a match — or isn't found at all.
//
// This also folds in the old `escapeTolerantIndexOf` fix for free: the measured case was
// `rawText` writing `Yahoo\!ショッピング` for the merchant `Yahoo!ショッピング` — `\` and `!`
// are both stripped by `fuzz()` on EITHER side, so the stray backslash never needed a dedicated
// tolerance rule to begin with.
export function fuzzyFirstIndex(haystack, needle) {
  const h = String(haystack ?? '')
  const n = String(needle ?? '')
  if (!h || !n) return -1
  const needleFuzz = fuzz(n)
  if (needleFuzz.length < minFuzzLength(needleFuzz)) return -1
  const { folded, origin } = foldWithOriginIndex(h)
  const idx = folded.indexOf(needleFuzz)
  if (idx === -1) return -1
  return origin[idx]
}

// The evidence rule agents get wrong (SKILL.md P4.5): support means the NAME is findable, not
// that the copied evidence quote is verbatim (which always trivially passes). Same fuzz-based
// matching as the backend's `isSupported`/`isMentionSupported` (detect-flow.service.ts) — a
// diacritic-folded or non-Latin name must match here the same way it matches server-side, so
// client-side "is this merchant real" checking agrees with the backend, not just position.
export function isSupported(merchant, response) {
  const name = String(merchant?.name ?? '')
  if (!name.trim()) return false
  const textFuzz = fuzz(response?.rawText)
  const nameFuzz = fuzz(name)
  if (nameFuzz.length >= minFuzzLength(nameFuzz) && textFuzz.includes(nameFuzz)) return true
  const citeDomains = (response?.citations ?? []).map((c) => normDomain(c.domain))
  if (merchant.domain && citeDomains.includes(normDomain(merchant.domain))) return true
  if (Array.isArray(merchant.urls) && merchant.urls.some((u) => citeDomains.includes(normDomain(u)))) return true
  const evFuzz = fuzz(merchant?.evidence)
  if (evFuzz.length >= 12 && textFuzz.includes(evFuzz)) {
    const tokens = foldDiacritics(name).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4)
    const nameTokens = tokens.length > 0 ? tokens : nameFuzz.length > 0 ? [nameFuzz] : []
    if (nameTokens.some((t) => evFuzz.includes(t))) return true
  }
  return false
}

// Does this answer write out a money figure at all? Gates the price/shipping warnings below so
// they only fire where a figure demonstrably existed to be picked up. `\p{Sc}` is the Unicode
// "currency symbol" property, so $ € £ ¥ ₩ ₹ ₺ ₦ ﷼ … come free instead of a per-market allowlist;
// the other branch is a 3-letter ISO code next to a digit ("AED 135", "135 SAR"). Same regex as
// the backend's `answerStatesMoney` (byok-validate.util.ts) — keep the two in sync. This detects
// only; it never parses or rewrites a price (that mistake shipped three times, see
// backend/src/shared/format/offer-value.ts).
const MONEY_SIGNAL = /\p{Sc}\s?\d|\d\s?\p{Sc}|\b[A-Z]{3}\s?\d|\d\s?[A-Z]{3}\b/u
export const answerStatesMoney = (rawText) => MONEY_SIGNAL.test(String(rawText ?? ''))

// PRICE and SHIPPING are two columns the customer reads, and null renders as "N/A". Warn per cell,
// on the two intents whose question all but forces the answer to state a figure per merchant, and
// only when the answer really does contain one — nothing in this toolchain used to look at these
// two fields at all.
//
// What the warning claims, exactly: **no valid value was extracted for this cell**. Not why. The
// same N/A symptom has had three different causes so far (the answer genuinely naming no figure,
// retrieval returning a different answer, and — the one that actually caused the big incidents — a
// normalizer at the READ layer throwing away values the DB held correctly). Two of the three got
// "fixed" at the wrong layer because the symptom was read as a diagnosis. So: audit, then conclude.
const PRICE_INTENT = 'cheapest'
const SHIPPING_INTENT = 'free_shipping'
const hasPrice = (m) => m.price != null || String(m.priceRaw ?? '').trim() !== ''
const hasShipping = (m) => String(m.shipping ?? '').trim() !== ''

export function checkOffers({ cell }) {
  const merchants = cell.detection?.merchants ?? []
  if (merchants.length === 0) return []
  if (!answerStatesMoney(cell.response?.rawText)) return []
  const out = []
  if (cell.intentSlug === PRICE_INTENT && !merchants.some(hasPrice)) {
    out.push({
      code: 'WARN_NO_PRICE_EXTRACTED',
      detail: `"${PRICE_INTENT}" answer states a money figure, yet no valid price came out for any of its ${merchants.length} merchants — those rows ship as N/A. Check whether the figure belongs to a specific merchant (a product-level price legitimately stays null); if it does, fill priceRaw verbatim`,
    })
  }
  if (cell.intentSlug === SHIPPING_INTENT && !merchants.some(hasShipping)) {
    out.push({
      code: 'WARN_NO_SHIPPING_EXTRACTED',
      detail: `"${SHIPPING_INTENT}" answer states a money figure, yet no valid shipping value came out for any of its ${merchants.length} merchants — those rows ship as N/A. Only fill it with an actual shipping condition; "free returns" / "delivery 2-3 days" are not one, and a free-over threshold must never be reduced to the bare number`,
    })
  }
  return out
}

// meta.json → the identities of the target shop, in the shapes an answer can name it: the shop
// name + aliases, and its domain(s). `storeUrl` is often a full URL and `shopDomain` a bare host —
// normalize both to a comparable host.
export const normDomain = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')

export function targetFromMeta(meta) {
  if (!meta) return null
  const shop = meta.shop ?? {}
  const names = [shop.name, ...(shop.nameAliases ?? shop.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase())
  const domains = [shop.primaryDomain, shop.storeUrl, meta.shopDomain, shop.domain, ...(shop.domains ?? [])]
    .filter(Boolean)
    .map(normDomain)
    .filter(Boolean)
  if (names.length === 0 && domains.length === 0) return null
  return { names, domains: [...new Set(domains)] }
}

// The finding a per-cell analyzer structurally cannot make: it was told which shop is the target,
// but nothing tells it that IT alone missed one every other cell caught. Warnings, not errors —
// "the product's brand shares the shop's name" is a real case and the human/agent decides it.
export function checkTarget({ file, cell }, target) {
  if (!target || !cell.detection) return []
  const merchants = cell.detection.merchants ?? []
  const raw = String(cell.response?.rawText ?? '').toLowerCase()
  const citeDomains = (cell.response?.citations ?? []).map((c) => normDomain(c.domain))
  const isTarget = (m) =>
    target.domains.includes(normDomain(m.domain)) || target.names.includes(String(m.name ?? '').toLowerCase())

  const out = []
  const flagged = merchants.filter((m) => m.isTargetShop)
  const domainInAnswer = target.domains.find((d) => d && (raw.includes(d) || citeDomains.includes(d)))
  const nameInAnswer = target.names.find((n) => n && raw.includes(n))

  // The shop IS in the list but unflagged is the more precise finding below — don't say both.
  const listed = merchants.some(isTarget)
  if (flagged.length === 0 && !listed && (domainInAnswer || nameInAnswer)) {
    out.push({
      code: 'WARN_TARGET_MISSED',
      detail: `the answer names the target shop (${domainInAnswer ?? nameInAnswer}) yet no merchant carries isTargetShop — re-read the cell: if it is named as a place to buy it belongs in the list, if only the product/brand is discussed this warning is correct to ignore`,
    })
  }
  for (const m of flagged) {
    if (!isTarget(m)) {
      out.push({
        code: 'WARN_TARGET_MISLABELED',
        detail: `"${m.name}" (${m.domain ?? 'no domain'}) is flagged isTargetShop but matches neither the shop name/aliases (${target.names.join(', ') || '—'}) nor its domain(s) (${target.domains.join(', ') || '—'})`,
      })
    }
  }
  for (const m of merchants) {
    if (!m.isTargetShop && isTarget(m)) {
      out.push({
        code: 'WARN_TARGET_NOT_FLAGGED',
        detail: `"${m.name}" (${m.domain ?? 'no domain'}) IS the target shop but isTargetShop is false — the report's own-shop rank reads from this flag`,
      })
    }
  }
  return out.map((v) => ({ file, ...v }))
}

// R4 (#287, B3): a dedup key that folds Japanese filler characters and branch-store suffixes —
// `の`/`・`/`ー` are valid \p{L} letters so a plain lowercase+trim never catches "熊野筆の北斗園"
// and "熊野筆 北斗園" as the same store, and neither does grouping by domain when one side's
// domain is null (exactly the measured case: #14 domain `store.shopping.yahoo.co.jp`, #19
// domain empty — different name AND different domain, so the byDomain/byName grouping below
// never puts them in the same bucket). Folding is for MATCHING only, never for display.
const JP_FILLER = /[のー・]/gu
const JP_STORE_SUFFIX = /(本店|支店|店)$/u

export function mergeDedupKey(name) {
  const compact = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(JP_FILLER, '')
  return compact.replace(JP_STORE_SUFFIX, '')
}

// Cross-cell agreement. Merchants are de-duplicated on domain, so one brand written two ways
// across cells becomes two rows on the customer's report — and no single analyzer can see it,
// because each one only ever read its own cell. Warnings: a genuine split (sephora.me vs
// sephora.sa, each really cited in its own cell) is accepted by SKILL.md P4.5.
export function checkConsistency(entries, target = null) {
  const byDomain = new Map()
  const byName = new Map()
  const byMergeKey = new Map()
  for (const { file, cell } of entries) {
    for (const m of cell.detection?.merchants ?? []) {
      const d = normDomain(m.domain)
      const n = String(m.name ?? '').trim().toLowerCase()
      if (d) {
        if (!byDomain.has(d)) byDomain.set(d, new Map())
        if (!byDomain.get(d).has(n)) byDomain.get(d).set(n, { name: m.name, files: [] })
        byDomain.get(d).get(n).files.push(file)
      }
      if (n) {
        if (!byName.has(n)) byName.set(n, new Map())
        if (!byName.get(n).has(d)) byName.get(n).set(d, { domain: m.domain, files: [] })
        byName.get(n).get(d).files.push(file)
      }
      const key = mergeDedupKey(m.name)
      const rawName = String(m.name ?? '').trim()
      if (key && rawName) {
        if (!byMergeKey.has(key)) byMergeKey.set(key, new Map())
        const variants = byMergeKey.get(key)
        if (!variants.has(rawName)) variants.set(rawName, { domain: m.domain, files: [] })
        variants.get(rawName).files.push(file)
      }
    }
  }

  const out = []
  for (const [domain, names] of byDomain) {
    if (names.size < 2) continue
    const spellings = [...names.values()].map((v) => `"${v.name}" (${v.files.join(', ')})`)
    out.push({
      file: '(set)',
      code: 'WARN_MERCHANT_NAME_CONFLICT',
      detail: `${domain} is named ${names.size} different ways across cells — ${spellings.join(' vs ')}. One of them becomes the label on the report row; pick one and rewrite the others`,
    })
  }
  for (const [name, domains] of byName) {
    if (domains.size < 2) continue
    const variants = [...domains.values()].map((v) => `${v.domain ?? 'null'} (${v.files.join(', ')})`)
    // The same split on the TARGET shop is not a cosmetic duplicate: the report's own-shop rank
    // and visibility score are computed per merchant row, so a split halves the shop against
    // itself. Measured on a shipped run: glowtheory.com in 12 cells, glowtheory.co.za in 5.
    const isTargetName = Boolean(target?.names.includes(name))
    out.push({
      file: '(set)',
      code: isTargetName ? 'WARN_TARGET_SHOP_SPLIT' : 'WARN_MERCHANT_DOMAIN_CONFLICT',
      detail: `${isTargetName ? 'THE TARGET SHOP ' : ''}"${name}" carries ${domains.size} different domains — ${variants.join(' vs ')}. Dedup is on domain, so this ships as ${domains.size} rows${isTargetName ? ', splitting the shop\'s own rank across them' : ''}; keep the split only where each cell really cited that domain (SKILL.md P4.5), and never leave one of them null`,
    })
  }
  // R4 (#287, B3): catches the pair byDomain/byName both miss — different name AND different
  // (or null) domain, but the SAME store once の/・/ー/branch-suffix noise is folded out.
  for (const [key, variants] of byMergeKey) {
    if (variants.size < 2) continue
    const spellings = [...variants.entries()].map(
      ([name, v]) => `"${name}" (${v.domain ?? 'no domain'}; ${v.files.join(', ')})`,
    )
    out.push({
      file: '(set)',
      code: 'WARN_MERCHANT_NORMALIZED_DUP',
      detail: `${variants.size} spellings fold to the same key ("${key}") after stripping whitespace/の/・/ー and a 本店|支店|店 suffix, but carry different name/domain in this grid — ${spellings.join(' vs ')}. Almost certainly one store split across report rows; reconcile to one name and domain`,
    })
  }
  return out
}

// Same lookup as `fuzzyFirstIndex`, but falls back to the merchant's own `evidence` quote when
// the name itself can't be located (e.g. a spelling/escaping shape even the fuzzy match can't
// unwind). This doesn't invent a position: DETECTION_UNSUPPORTED_MERCHANT already requires the
// name, the evidence, or a cited domain to be real — reading the evidence quote's own offset is
// reading a piece of the cell that genuinely is positioned, not guessing one.
//
// Kept name/signature (mirrors backend's `merchantFirstIndex`, ADR-0040) — `expectedOrder`
// below and this file's own tests reference it by this name.
export function nameIndexInRawText(rawText, merchant) {
  const byName = fuzzyFirstIndex(rawText, merchant?.name)
  if (byName !== -1) return byName
  if (merchant?.evidence) return fuzzyFirstIndex(rawText, merchant.evidence)
  return -1
}

// The correct `position` for every merchant, purely from where each name (or its evidence
// fallback) first appears in `rawText` — R3's "don't trust the analyzer, recompute by
// machine". Returns null when even ONE merchant in the cell can't be located at all (e.g.
// citation-only support with no textual presence): with no ground truth for that merchant we
// have no basis to say the OTHERS are out of order either, so the whole cell is skipped rather
// than risk a false positive.
export function expectedOrder(merchants, rawText) {
  const idx = merchants.map((m) => nameIndexInRawText(rawText, m))
  if (idx.some((i) => i === -1)) return null
  const order = new Array(merchants.length)
  idx
    .map((i, pos) => ({ pos, i }))
    .sort((a, b) => a.i - b.i || a.pos - b.pos)
    .forEach((e, rank) => {
      order[e.pos] = rank + 1
    })
  return order
}

// One cell's detection against the DETECTION_* codes (RECOVERY.md) plus the extra sanity checks
// SKILL.md calls out (evidence length, a citation source claim that isn't actually cited).
export function checkCell({ file, cell }) {
  const violations = []
  const merchants = cell.detection?.merchants ?? []
  const citeDomains = new Set((cell.response?.citations ?? []).map((c) => String(c.domain ?? '').toLowerCase()))

  let targets = 0
  const positions = []
  for (const m of merchants) {
    if (!m.name || !String(m.name).trim()) {
      violations.push({ code: 'DETECTION_EMPTY_NAME', detail: `position ${m.position}` })
    }
    if (m.isTargetShop) targets++
    positions.push(m.position)
    if (!m.mentionSources || m.mentionSources.length === 0) {
      violations.push({ code: 'DETECTION_MISSING_SOURCE', detail: m.name })
    }
    if (!isSupported(m, cell.response)) {
      violations.push({ code: 'DETECTION_UNSUPPORTED_MERCHANT', detail: `${m.name} — name not found in rawText, evidence, or citations` })
    }
    if (typeof m.evidence === 'string' && m.evidence.length > 160) {
      violations.push({ code: 'WARN_EVIDENCE_TOO_LONG', detail: `${m.name} — ${m.evidence.length} chars (spec caps at 160)` })
    }
    if (m.mentionSources?.includes('citation') && m.domain && !citeDomains.has(String(m.domain).toLowerCase())) {
      violations.push({ code: 'WARN_FALSE_CITATION_SOURCE', detail: `${m.name} claims 'citation' but ${m.domain} isn't in this cell's citations` })
    }
  }
  if (targets > 1) violations.push({ code: 'DETECTION_MULTIPLE_TARGETS', detail: `${targets} merchants flagged isTargetShop` })

  const n = merchants.length
  const wantPositions = Array.from({ length: n }, (_, i) => i + 1)
  const gotPositions = [...positions].sort((a, b) => a - b)
  if (n > 0 && JSON.stringify(gotPositions) !== JSON.stringify(wantPositions)) {
    violations.push({ code: 'DETECTION_BAD_POSITIONS', detail: `got [${positions.join(',')}], want 1..${n} with no gaps/dupes` })
  } else if (n > 1) {
    // R3 upgrade (#287, C2): a set that IS a valid 1..n permutation can still be the WRONG
    // permutation — measured case: the analyzer sorted by "recommendation strength" instead of
    // appearance order (竹宝堂 at rawText index 187 filed as position 3, while ふるさとチョイス
    // at index 312 took position 1). `position` feeds `bestRank` straight through, so a
    // plausible-looking 1..n set can still print the wrong winner on the customer's report.
    const order = expectedOrder(merchants, cell.response?.rawText)
    if (order && merchants.some((m, i) => m.position !== order[i])) {
      violations.push({
        code: 'DETECTION_BAD_POSITIONS',
        detail: `positions are a valid 1..${n} set but out of first-appearance order in rawText — got [${positions.join(',')}], want [${order.join(',')}]`,
      })
    }
  }

  violations.push(...checkOffers({ cell }))

  return violations.map((v) => ({ file, ...v }))
}

// R1 (#287, C1): the cross-cell sweep a per-cell analyzer structurally cannot do. Union every
// merchant name ever extracted ANYWHERE in the grid, then run each one as a plain substring
// check against every OTHER cell's own rawText — a hit that cell's own detection doesn't carry
// means that analyzer skipped a merchant every other cell caught. Measured on the source
// incident: 11 merchants present verbatim in a cell's rawText but missing from that cell's
// detection, one cell alone missing 3/13 (~23%). Exact substring only (mirrors the issue's own
// `strpos` repro) — R3's markdown-escape tolerance is a different failure mode (position, not
// presence) and isn't needed here.
export function checkCrossCellMisses(entries) {
  const allNames = new Set()
  for (const { cell } of entries) {
    for (const m of cell.detection?.merchants ?? []) {
      const name = String(m.name ?? '').trim()
      if (name) allNames.add(name)
    }
  }
  const out = []
  for (const { file, cell } of entries) {
    const raw = String(cell.response?.rawText ?? '').toLowerCase()
    if (!raw) continue
    const detected = new Set((cell.detection?.merchants ?? []).map((m) => String(m.name ?? '').trim().toLowerCase()))
    for (const name of allNames) {
      const lc = name.toLowerCase()
      if (detected.has(lc)) continue
      if (raw.includes(lc)) {
        out.push({
          file,
          code: 'WARN_MERCHANT_MISSED_IN_CELL',
          detail: `"${name}" appears verbatim in this cell's rawText and was extracted in another cell of this grid, but is missing from THIS cell's own detection — re-read the cell (or re-dispatch it) and add it if it really is a merchant mention here`,
        })
      }
    }
  }
  return out
}

// R5 (#287, B1): a raw_text that opens or closes with the COLLECTING AGENT's own tool-
// permission friction ("WebFetch was denied, so I couldn't open product pages — the answer
// below is from search results only", ending in "WebFetchを許可いただければ…") is not a
// shopper's answer — it's the agent lane leaking its own runtime state into the data the report
// measures, yet nothing today stops it from being scored and printed in the Appendix verbatim.
// Same pattern as the backend's check (byok-validate.util.ts) — keep the two in sync, same
// reasoning as `answerStatesMoney` above.
export const AGENT_LANE_CONTAMINATION_PATTERN =
  /WebFetch|web_search|permission|denied|を許可いただければ|search results only/

export function checkContamination(entries) {
  const out = []
  for (const { file, cell } of entries) {
    const raw = cell.response?.rawText
    if (raw && AGENT_LANE_CONTAMINATION_PATTERN.test(raw)) {
      out.push({
        file,
        code: 'AGENT_LANE_CONTAMINATION',
        detail: `rawText matches an agent-lane leak pattern (tool-permission refusal / meta-commentary about the collection itself, not a shopper's answer) — re-collect this cell, don't submit it as data`,
      })
    }
  }
  return out
}

// DETECTION_PARTIAL is a property of the whole submission, not one cell: either every cell
// carries `detection` or none does (SKILL.md "All-or-nothing").
export function checkSet(entries, { meta = null } = {}) {
  const withDetection = entries.filter((e) => e.cell.detection).length
  const partial = withDetection > 0 && withDetection < entries.length
  const target = targetFromMeta(meta)
  const analyzed = entries.filter((e) => e.cell.detection)
  // R5 (#287, B1): runs on EVERY cell regardless of detection — a contaminated rawText is bad
  // data whether or not client-analysis happened, so it must not ride along with the
  // "no cell carries detection, that's a valid skip" fast path below.
  const contamination = checkContamination(entries)
  const perCell = partial
    ? []
    : [
        ...analyzed.flatMap(checkCell),
        ...analyzed.flatMap((e) => checkTarget(e, target)),
        ...(analyzed.length > 0 ? checkConsistency(analyzed, target) : []),
        // R1 (#287, C1): needs at least 2 analyzed cells to compare against each other.
        ...(analyzed.length > 0 ? checkCrossCellMisses(analyzed) : []),
      ]
  const violations = partial
    ? [
        { file: '(set)', code: 'DETECTION_PARTIAL', detail: `${withDetection}/${entries.length} cells carry detection — analyze the rest or strip it from all` },
        ...contamination,
      ]
    : [...contamination, ...perCell]
  return {
    ok: !partial && violations.length === 0,
    skipped: withDetection === 0,
    partial,
    withDetection,
    total: entries.length,
    violations,
  }
}

// `--fix`: mechanically correct `position` wherever `expectedOrder()` reaches a verdict
// (ADR-0040). Unlike merchant identity / price / shipping — genuine analyst judgment, see
// SKILL.md P4.5 — `position` is a pure function of where each name (or its evidence fallback)
// first appears in `rawText`; once `expectedOrder()` returns a result there is no interpretation
// left to preserve, so this overwrites the cell file in place instead of only flagging it. A
// null verdict (some merchant isn't locatable at all) is left untouched — same as without
// `--fix`: report the violation, never guess.
export function applyPositionFixes(entries) {
  const fixes = []
  for (const { file, path, cell } of entries) {
    const merchants = cell.detection?.merchants
    if (!Array.isArray(merchants) || merchants.length < 2) continue
    const order = expectedOrder(merchants, cell.response?.rawText)
    if (!order) continue
    let changed = false
    merchants.forEach((m, i) => {
      if (m.position !== order[i]) {
        fixes.push({ file, name: m.name, from: m.position, to: order[i] })
        m.position = order[i]
        changed = true
      }
    })
    if (changed) writeFileSync(path, JSON.stringify(cell, null, 2))
  }
  return fixes
}

export function main(argv) {
  const a = parseArgs(argv)
  if (!a.cells) throw new Error('--cells <dir|file> is required')
  const entries = loadCellFiles(a.cells)
  const meta = a.meta ? JSON.parse(readFileSync(a.meta, 'utf8')) : null
  const fixes = a.fix ? applyPositionFixes(entries) : []
  return { ...checkSet(entries, { meta }), fixes }
}

if (isMainModule(import.meta.url)) {
  let result
  try {
    result = main(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  // ADR-0040: print one line per merchant `--fix` actually rewrote, before anything else —
  // a corrected position changes what the rest of this report is even describing.
  for (const f of result.fixes ?? []) {
    console.log(`FIX  ${f.file}: "${f.name}" position ${f.from} → ${f.to}`)
  }
  // R5 (#287): a skip (no cell carries detection) is only a no-op print when it ALSO carries no
  // violations — contamination is checked independently of detection, so a contaminated cell in
  // an otherwise-skipped run must still fall through to the normal FAIL/exit-1 path below.
  if (result.skipped && result.violations.length === 0) {
    console.log('no cell carries detection — client analysis was skipped for this run (fine if that was a deliberate choice, see SKILL.md P4.5)')
    process.exit(0)
  }
  const hardErrors = result.violations.filter((v) => !v.code.startsWith('WARN_'))
  const warnings = result.violations.filter((v) => v.code.startsWith('WARN_'))
  for (const v of warnings) console.warn(`WARN  ${v.file}: ${v.code} — ${v.detail}`)
  for (const v of hardErrors) console.error(`FAIL  ${v.file}: ${v.code} — ${v.detail}`)
  if (hardErrors.length) {
    console.error(`\n${hardErrors.length} guard violation(s) across ${result.total} cells (${result.withDetection} carry detection) — fix before validate_byok_submission.`)
    process.exit(1)
  }
  console.log(`ok — ${result.withDetection}/${result.total} cells carry detection, all guards clean${warnings.length ? ` (${warnings.length} warning(s) above)` : ''}.`)
  if (!parseArgs(process.argv.slice(2)).meta) {
    console.log('note — no --meta meta.json: the target-shop and cross-cell agreement checks were skipped. Pass it after a fanned-out analysis.')
  }
}
