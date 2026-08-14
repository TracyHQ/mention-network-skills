// Fan out P4 collection across a whole grid with the concurrency caps SKILL.md already
// prescribes ("Collect in parallel — this is where the wall-clock time goes"), instead of the
// agent hand-rolling `launch each … & … wait` per run. Measured 2026-07-28 on a real run
// (glowtheory.com): vendor-CLI cells that should overlap 2-3 at a time landed one after another
// with multi-minute gaps between them — collection alone took 5m41s of an 8m54s run. This
// script is the pooled version of that loop; it does not change what each cell costs, only how
// many run at once.
//
// Does NOT cover `google_ai_mode` on Playwright — SKILL.md is explicit that route has no
// collector script (one shared browser MCP session, driven by the agent directly). Feed this
// script the other three routes' cells; collect Playwright cells the usual way alongside it.
//
// Usage:
//   node collect-pool.mjs --grid grid.json [--concurrency cli=2,api=5,agent-sdk=5,serpapi=5]
//
// grid.json is an array of jobs:
//   { "route": "cli", "engine": "chatgpt", "intent": "where_to_buy", "platform": "chatgpt",
//     "prompt": "...", "out": "cells/where_to_buy.chatgpt.json" }
//   { "route": "api", "provider": "openai", "model": "gpt-5.5", "intent": "...", "platform": "...",
//     "prompt": "...", "out": "..." }
//   { "route": "agent-sdk", "intent": "...", "platform": "claude", "prompt": "...", "out": "..." }
//   { "route": "serpapi", "hl": "ar", "gl": "SA", "intent": "...", "platform": "google_ai_mode",
//     "prompt": "...", "out": "..." }
//
// Each job is handed to the matching collect-*.mjs unchanged — this script only pools and
// retries at the process level; the collectors keep their own retry/backoff for 429/503
// (RECOVERY.md "Collection failures"). One outer retry catches the rest (a killed process, a
// bad flag) before a cell is reported failed. A cell that fails twice is left `failed` for the
// agent to triage per RECOVERY.md — never silently dropped, never retried forever.
//
// Prints a JSON summary to stdout: { total, ok, failed: [{ job, log }], durationMs }. Exits 1 if
// any cell is still failed after its retry.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(moduleUrl)
  } catch {
    return false
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))

// SKILL.md P4: vendor CLIs 2-3 concurrent (a subscription allows only a few sessions), API /
// SerpApi / Agent SDK 4-6 per key. Picked the conservative end of each range as the default.
export const DEFAULT_CONCURRENCY = { cli: 2, api: 4, 'agent-sdk': 4, serpapi: 4 }

export function parseArgs(argv) {
  const out = { grid: null, concurrency: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    const rawKey = eq === -1 ? a.slice(2) : a.slice(2, eq)
    let val
    if (eq !== -1) val = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i]
    if (val === undefined) continue
    if (rawKey === 'grid') out.grid = val
    if (rawKey === 'concurrency') {
      for (const pair of val.split(',')) {
        const [k, v] = pair.split('=')
        if (k && v) out.concurrency[k.trim()] = Number(v)
      }
    }
  }
  return out
}

const SCRIPT_BY_ROUTE = {
  cli: 'collect-cli.mjs',
  api: 'collect-api.mjs',
  'agent-sdk': 'collect-agent-sdk.mjs',
  serpapi: 'collect-serpapi.mjs',
}

export function poolKeyFor(job) {
  if (job.route === 'cli') return `cli:${job.engine}`
  if (job.route === 'api') return `api:${job.provider}`
  return job.route // 'agent-sdk' | 'serpapi' — one pool each, no per-key split
}

// route-family prefix used to look up the concurrency cap ('cli:chatgpt' -> 'cli').
function routeFamily(poolKey) {
  return poolKey.split(':')[0]
}

export function buildArgs(job) {
  if (!SCRIPT_BY_ROUTE[job.route]) throw new Error(`unknown route "${job.route}" (want cli|api|agent-sdk|serpapi)`)
  const common = ['--intent', job.intent, '--out', job.out]
  if (job.platform) common.push('--platform', job.platform)
  if (job.route === 'cli') {
    if (!job.engine) throw new Error(`cli job for intent "${job.intent}" is missing "engine"`)
    const args = ['--engine', job.engine, ...common]
    if (job.model) args.push('--model', job.model)
    if (job.timeoutMs) args.push('--timeout-ms', String(job.timeoutMs))
    return args
  }
  if (job.route === 'api') {
    if (!job.provider || !job.model) throw new Error(`api job for intent "${job.intent}" needs "provider" and "model"`)
    return ['--provider', job.provider, '--model', job.model, ...common]
  }
  if (job.route === 'agent-sdk') {
    const args = [...common]
    if (job.model) args.push('--model', job.model)
    return args
  }
  // serpapi
  if (!job.hl || !job.gl) throw new Error(`serpapi job for intent "${job.intent}" needs "hl" and "gl"`)
  return ['--hl', job.hl, '--gl', job.gl, ...common]
}

// Runs one job as a child process, prompt on stdin, stdout+stderr captured to `<out>.log`.
// Injectable `spawnFn` for tests — default is the real node:child_process.spawn.
export function runOnce(job, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const script = join(HERE, SCRIPT_BY_ROUTE[job.route])
    const args = buildArgs(job)
    const child = spawnFn('node', [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    child.on('error', (e) => resolve({ ok: false, log: log + String(e.message) }))
    child.on('close', (code) => resolve({ ok: code === 0, log }))
    child.stdin.write(job.prompt ?? '')
    child.stdin.end()
  })
}

export async function runJob(job, deps = {}) {
  let result = await runOnce(job, deps)
  let attempts = 1
  if (!result.ok) {
    await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 3000))
    result = await runOnce(job, deps)
    attempts = 2
  }
  const logPath = `${job.out}.log`
  if (!deps.skipLogWrite) {
    try { writeFileSync(logPath, result.log) } catch { /* best-effort — a bad --out dir surfaces via the job's own failure */ }
  }
  return { job, ok: result.ok, attempts, log: logPath }
}

// A tiny concurrency-limited map: at most `limit` promises from `worker` in flight at once.
async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

export async function runGrid(jobs, { concurrency = {}, ...deps } = {}) {
  const caps = { ...DEFAULT_CONCURRENCY, ...concurrency }
  const groups = new Map()
  for (const job of jobs) {
    const key = poolKeyFor(job)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(job)
  }
  const started = Date.now()
  const perGroup = await Promise.all(
    [...groups.entries()].map(([key, group]) => mapPool(group, caps[routeFamily(key)] ?? 4, (j) => runJob(j, deps))),
  )
  const results = perGroup.flat()
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).map((r) => ({ job: r.job, log: r.log })),
    durationMs: Date.now() - started,
  }
}

export async function main(argv, deps = {}) {
  const a = parseArgs(argv)
  if (!a.grid) throw new Error('--grid <file> is required')
  const jobs = JSON.parse(readFileSync(a.grid, 'utf8'))
  if (!Array.isArray(jobs)) throw new Error('grid file must be a JSON array of jobs')
  return runGrid(jobs, { concurrency: a.concurrency, ...deps })
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2))
      if (r.failed.length) process.exit(1)
    })
    .catch((e) => { console.error(e.message); process.exit(1) })
}
