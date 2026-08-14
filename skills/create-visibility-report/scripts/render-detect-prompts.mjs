// Render the LIVE detect-extraction prompt (get_detect_extraction_spec) once per cell, so the
// analysis of every cell is asked for in exactly the same words — whoever runs it.
//
// Why this exists: P4.5 is normally fanned out to analyzer sub-agents, one per cell. A sub-agent
// that is briefed in the delegating agent's own paraphrase extracts to a different standard than
// one briefed with the backend's prompt, and the two disagree about merchants, positions and
// prices. The disagreement is then re-litigated by eye, cell by cell, which is expensive and still
// arbitrary. The fix is upstream: one rendered prompt file per cell, taken verbatim from the spec
// the backend's own analyzer uses (ADR-0027 — "client tự làm extraction thì phải dùng ĐÚNG prompt
// + schema này, nếu không hai lane trích khác nhau"), handed to whoever does the work.
//
// Usage:
//   node render-detect-prompts.mjs --cells cells/ --meta meta.json --spec spec.json --out analysis/
//
// `spec.json` is whatever get_detect_extraction_spec returned (raw object, or the MCP
// content[0].text envelope — both are accepted). Writes analysis/<cell>.prompt.md per cell plus
// analysis/manifest.json, and prints one line per cell.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync } from 'node:fs'
import { join, basename } from 'node:path'
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

const KEYS = ['cells', 'meta', 'spec', 'out']

export function parseArgs(argv) {
  const out = { cells: null, meta: null, spec: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (!KEYS.includes(key)) continue
    let val
    if (eq !== -1) val = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i]
    if (val !== undefined) out[key] = val
  }
  return out
}

// get_detect_extraction_spec comes back either as the plain object or wrapped in the MCP
// content envelope, depending on whether it was fetched through the host tools or mcp-client.mjs.
// Both are the same payload — unwrap rather than making the caller normalize it by hand.
export function unwrapSpec(raw) {
  let s = raw
  if (s && Array.isArray(s.content)) {
    const text = s.content.find((c) => c?.type === 'text')?.text
    if (text) s = JSON.parse(text)
  }
  if (s && s.spec && !s.promptTemplate) s = s.spec
  if (!s || typeof s.promptTemplate !== 'string') {
    throw new Error('spec has no promptTemplate — pass the output of get_detect_extraction_spec')
  }
  return s
}

const truncate = (s, max) => (!max || s.length <= max ? s : `${s.slice(0, max)}\n[...truncated...]`)

// Mirrors the backend's own citation block (detect-shops.prompt.ts): grouped by domain, first
// title wins, at most 3 urls each. The template carries `{citations}` inside an already-rendered
// one-entry block, so the section is rebuilt rather than substituted.
export function renderCitations(citations = []) {
  if (citations.length === 0) {
    return '(none — the answer has no cited URLs; extract merchants from prose only and return empty citationVerdicts)'
  }
  const byDomain = new Map()
  for (const c of citations) {
    const domain = c.domain ?? ''
    const entry = byDomain.get(domain) ?? { urls: new Set(), titles: new Set() }
    if (c.url) entry.urls.add(c.url)
    if (c.title) entry.titles.add(c.title)
    byDomain.set(domain, entry)
  }
  const lines = []
  let i = 1
  for (const [domain, entry] of byDomain) {
    const title = [...entry.titles][0] ?? ''
    lines.push(`- [${i}] ${domain}${title ? ` — "${title}"` : ''}`)
    for (const u of [...entry.urls].slice(0, 3)) lines.push(`      ${u}`)
    i++
  }
  return lines.join('\n')
}

// A placeholder that sits alone on a line (aliases, domains) has no value to print when the meta
// doesn't carry one — drop the whole line instead of leaving "- known aliases: ".
function fillLine(template, placeholder, value) {
  if (value) return template.split(placeholder).join(value)
  return template
    .split('\n')
    .filter((l) => !l.includes(placeholder))
    .join('\n')
}

// Everything this renderer knows how to fill. A spec that grows a placeholder outside this set
// must not be rendered on a guess — the analyzer would silently work from an incomplete brief.
const KNOWN_PLACEHOLDERS = new Set([
  '{shopName}', '{shopAliases}', '{shopDomains}', '{productTitle}',
  '{model}', '{question}', '{answerText}', '{citations}',
])

export function renderPrompt({ spec, meta, cell }) {
  const unknown = [...new Set(spec.promptTemplate.match(/\{[a-zA-Z]+\}/g) ?? [])].filter((p) => !KNOWN_PLACEHOLDERS.has(p))
  if (unknown.length > 0) {
    throw new Error(`spec carries placeholder(s) this renderer cannot fill: ${unknown.join(', ')} — re-read get_detect_extraction_spec and teach render-detect-prompts.mjs the new field`)
  }
  const shop = meta.shop ?? {}
  const product = meta.product ?? {}
  const response = cell.response ?? {}

  // Everything up to the CITATIONS header is the substitutable part; the citations block itself
  // is rebuilt from this cell's own citations.
  const head = spec.promptTemplate.split('## CITATIONS')[0]

  let out = head
  out = fillLine(out, '{shopAliases}', (shop.nameAliases ?? shop.aliases ?? []).join(', '))
  out = fillLine(out, '{shopDomains}', (shop.domains ?? [shop.primaryDomain, shop.storeUrl].filter(Boolean)).join(', '))
  out = out.split('{shopName}').join(shop.name ?? meta.shopDomain ?? '(unnamed shop)')
  out = out.split('{productTitle}').join(product.title ?? meta.product ?? '')
  out = out.split('{model}').join(response.servedModel || cell.platformSlug || 'unknown')
  out = out.split('{question}').join(cell.promptText ?? '')
  out = out.split('{answerText}').join(truncate(String(response.rawText ?? ''), spec.limits?.answerTextMaxChars))
  out = `${out}## CITATIONS\n${renderCitations(response.citations)}\n`

  // Template drift is silent otherwise: an unreplaced placeholder reaches the analyzer as the
  // literal string and it happily analyzes "{productTitle}".
  const left = out.match(/\{[a-zA-Z]+\}/g)
  if (left) throw new Error(`unfilled placeholder(s) after render: ${[...new Set(left)].join(', ')} — the spec changed shape, re-read get_detect_extraction_spec`)
  return out
}

export function main(argv) {
  const a = parseArgs(argv)
  for (const k of KEYS) if (!a[k]) throw new Error(`--${k} is required`)

  const spec = unwrapSpec(JSON.parse(readFileSync(a.spec, 'utf8')))
  const meta = JSON.parse(readFileSync(a.meta, 'utf8'))
  const st = statSync(a.cells)
  const files = st.isDirectory()
    ? readdirSync(a.cells).filter((f) => f.endsWith('.json')).sort()
    : [basename(a.cells)]
  const dir = st.isDirectory() ? a.cells : ''

  mkdirSync(a.out, { recursive: true })
  const entries = []
  for (const f of files) {
    const path = dir ? join(dir, f) : a.cells
    const cell = JSON.parse(readFileSync(path, 'utf8'))
    const promptFile = join(a.out, `${f.replace(/\.json$/, '')}.prompt.md`)
    writeFileSync(promptFile, renderPrompt({ spec, meta, cell }))
    entries.push({
      cell: path,
      prompt: promptFile,
      intentSlug: cell.intentSlug ?? null,
      platformSlug: cell.platformSlug ?? null,
      answerChars: String(cell.response?.rawText ?? '').length,
      citations: (cell.response?.citations ?? []).length,
      hasDetection: Boolean(cell.detection),
    })
  }
  const manifest = { schemaName: spec.schemaName ?? null, jsonSchema: spec.jsonSchema ?? null, guards: spec.guards ?? [], cells: entries }
  const manifestFile = join(a.out, 'manifest.json')
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  return { manifestFile, entries }
}

if (isMainModule(import.meta.url)) {
  let result
  try {
    result = main(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  for (const e of result.entries) {
    console.log(`${e.prompt}  ← ${e.cell}  (${e.answerChars} chars, ${e.citations} citations${e.hasDetection ? ', already analyzed' : ''})`)
  }
  console.log(`\n${result.entries.length} prompt(s) + ${result.manifestFile} — hand one prompt file per analyzer, they write \`detection\` back into their own cell file.`)
}
