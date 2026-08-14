import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'

const Mustache = (await import(new URL('./vendor/mustache.min.js', import.meta.url).href)).default

export function parseArgs(argv) {
  const out = { template: 'default', data: 'report.json', out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (key !== 'template' && key !== 'data' && key !== 'out') continue
    let val
    if (eq !== -1) val = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i]
    if (val !== undefined) out[key] = val
  }
  return out
}

export function resolveTemplateDir(name, templatesRoot) {
  const dir = join(templatesRoot, name)
  if (existsSync(dir)) return { dir, warning: null }
  return { dir: join(templatesRoot, 'default'), warning: `template "${name}" not found — using default` }
}

const GAUGE_C = 2 * Math.PI * 54  // r=54 → 339.2920...
const LOGO_MAP = { chatgpt: 'logo-chatgpt.png', gemini: 'logo-gemini.png', google_ai_mode: 'logo-google.png', claude: 'logo-claude.png' }

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}
function cell(text) {
  return text ? { text, na: false } : { text: 'N/A', na: true }
}
function round1(n) { return Math.round(n * 1000) / 1000 }

// Both sections are OPTIONAL: `visibility` alone, `audit` alone (the website-audit skill
// produces audit-only reports), or both. A missing section is skipped here and its pages are
// skipped by the template, rather than throwing or printing blank pages.
export function normalizeReport(report) {
  const v = structuredClone(report)
  const vis = v.visibility
  if (vis) normalizeVisibility(v, vis)
  if (v.audit) normalizeAudit(v.audit)
  return v
}

function normalizeVisibility(v, vis) {
  vis.gauge = { dash: `${round1(GAUGE_C * vis.verdict.score / 100)} ${round1(GAUGE_C)}` }
  v.gauge = vis.gauge
  v.notRanked = vis.verdict.coverage.count === 0

  // Field names drifted between the report API and this renderer: the live
  // get_visibility_report returns `visibilityScorePct` on a competitor, `avgRank` on a
  // platform and on an intent, while the older shape (and tests/fixtures) use `sovPct`,
  // `rank` and `bestRank`. Accept BOTH — this renderer is the documented fallback for a
  // failed hosted export, so it must not be the thing that breaks when it's needed.
  // Measured 2026-07-28: an un-remapped live report died with `sovPct.toFixed of undefined`.
  for (const c of vis.marketPosition.competitors) c.sovPct ??= c.visibilityScorePct ?? 0
  for (const p of vis.chatbotVisibility.platforms) p.rank ??= p.avgRank ?? null
  for (const it of vis.searchIntent.intents) it.bestRank ??= it.avgRank ?? null

  const maxSov = Math.max(...vis.marketPosition.competitors.map((c) => c.sovPct), 0.0001)
  for (const c of vis.marketPosition.competitors) {
    c.sovBarPct = Math.round((c.sovPct / maxSov) * 100)
    c.logoUrl = c.domain ? `https://icons.duckduckgo.com/ip3/${c.domain}.ico` : ''
    c.initials = initials(c.name)
    c.priceCell = cell(c.priceDisplay)
    c.shipCell = cell(c.shippingDisplay)
    c.covText = `${c.coverage.count}/${c.coverage.total}`
    c.sovText = `${c.sovPct.toFixed(1)}%`
  }
  for (const p of vis.chatbotVisibility.platforms) {
    p.barPct = p.visibilityPct
    p.logoFile = LOGO_MAP[p.platform] || 'logo-chatgpt.png'
    p.logoDataUri = `data:image/png;base64,${readFileSync(new URL(`./assets/${p.logoFile}`, import.meta.url)).toString('base64')}`
    p.statusOk = p.isMentioned
    p.rankText = p.rank ? `#${p.rank}` : '—'
    p.pctText = p.isMentioned ? `${p.visibilityPct}%` : '—'
  }
  for (const it of vis.searchIntent.intents) {
    it.barPct = it.visibilityPct
    it.statusOk = it.isMentioned
    it.covText = `${it.coverage.count}/${it.coverage.total}`
    it.rankText = it.bestRank ? `#${it.bestRank}` : '—'
    it.pctText = it.isMentioned ? `${it.visibilityPct}%` : '—'
  }
}

// A null score means "nothing in here was measured" — printing it as 0/100 would read as a
// failing grade the audit never gave (common on a client-side run where whole sub-groups are na).
const scoreText = (score) => (score === null || score === undefined ? 'not measured' : `${Math.round(score)}/100`)

function normalizeAudit(aud) {
  for (const f of aud.factors || []) {
    f.scoreBarPct = Math.round(f.score || 0)
    f.scoreText = scoreText(f.score)
    for (const sg of f.subGroups || []) {
      sg.scoreBarPct = Math.round(sg.score || 0)
      sg.scoreText = scoreText(sg.score)
    }
  }
  for (const pr of aud.topPriorities || []) {
    pr.impactClass = String(pr.impact || 'low').toLowerCase()
  }
}

// Chrome fetches <img src> itself while printing, with no timeout we control — only the
// blunt 60s kill in htmlToPdf. Measured 2026-07-28: a real run's local-render step (report.json
// → PDF) took 1m22s for 3 competitors, plausibly Chrome waiting on icons.duckduckgo.com per
// logo with no bound. The backend's own PDF path (shared/pdf/favicon.ts) already prefetches
// favicons server-side, parallel, 3s timeout each, before rendering ever starts — same fix here:
// resolve every competitor logo to a data: URI (or '' → template's initials fallback) BEFORE
// handing HTML to Chrome, so `--print-to-pdf` never touches the network at all.
async function fetchLogoDataUri(url, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength < 100) return null
    const contentType = res.headers.get('content-type') ?? 'image/x-icon'
    return `data:${contentType};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

// Mutates and returns `view` — call after normalizeReport, right before renderHtml, only on
// the path that actually calls Chrome (main()). normalizeReport itself stays sync and keeps
// the plain logoUrl (tests assert that shape), since it's also used for HTML-only previews
// that never touch Chrome or the network.
export async function embedCompetitorLogos(view, opts = {}) {
  const competitors = view.visibility?.marketPosition?.competitors ?? []
  const withUrl = competitors.filter((c) => c.logoUrl?.startsWith('http'))
  await Promise.all(
    withUrl.map(async (c) => {
      c.logoUrl = (await fetchLogoDataUri(c.logoUrl, opts)) ?? ''
    }),
  )
  return view
}

export function renderHtml(view, templateDir) {
  const css = readFileSync(join(templateDir, 'report.css'), 'utf8')
  const template = readFileSync(join(templateDir, 'report.html'), 'utf8')
  return Mustache.render(template, { ...view, css })
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
].filter(Boolean)

export function findChrome() {
  return CHROME_PATHS.find((p) => existsSync(p)) || null
}

export function htmlToPdf(html, outPath, opts = {}) {
  const chrome = opts.chromePath || findChrome()
  if (!chrome) return Promise.reject(new Error('Chrome/Chromium not found. Install Google Chrome, then retry.'))
  const dir = mkdtempSync(join(tmpdir(), 'mnvr-'))
  const htmlFile = join(dir, 'report.html')
  writeFileSync(htmlFile, html)
  mkdirSync(dirname(outPath), { recursive: true })
  // AI logo images are embedded as base64 data: URIs in the template, so Chrome
  // never needs file:// access to local assets — keep --allow-file-access-from-files off.
  const args = ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${outPath}`, pathToFileURL(htmlFile).href]
  return new Promise((resolve, reject) => {
    execFile(chrome, args, { timeout: 60000 }, (err) => {
      if (err) return reject(err)
      if (!existsSync(outPath) || statSync(outPath).size === 0) {
        return reject(new Error('Chrome exited 0 but wrote no PDF'))
      }
      resolve()
    })
  })
}

export async function main(argv) {
  const a = parseArgs(argv)
  if (!a.out) throw new Error('--out <path.pdf> is required')
  const report = JSON.parse(readFileSync(a.data, 'utf8'))
  const view = normalizeReport(report)
  await embedCompetitorLogos(view)
  const templatesRoot = new URL('./templates/', import.meta.url).pathname
  const { dir, warning } = resolveTemplateDir(a.template, templatesRoot)
  if (warning) console.error('warning:', warning)
  const html = renderHtml(view, dir)
  await htmlToPdf(html, a.out)
  return { pdfPath: a.out }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((r) => console.log(r.pdfPath)).catch((e) => { console.error(e.message); process.exit(1) })
}
