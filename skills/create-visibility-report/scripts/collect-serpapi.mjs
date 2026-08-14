// Collect ONE BYOK cell for the **google_ai_mode** platform via **SerpApi**'s Google AI Mode
// engine (https://serpapi.com/search?engine=google_ai_mode). Google AI Mode has no API of its
// own; SerpApi fetches the real AI-Mode answer + its source links for you. The alternative is
// driving the AI Mode UI with the signed-out playwright MCP — this is the metered-key route.
//
// google_ai_mode is a browser-class cell: the backend validator requires `servedModel` EMPTY
// (UNEXPECTED_SERVED_MODEL) and the caller submits it as `collectionMethod:'browser'`. SerpApi
// is just the transport — we return `servedModel: null`. AI Mode inherently web-searches, so a
// non-empty answer means webSearchUsed:true.
//
// Needs `SERPAPI_API_KEY` in the env (the credential store holds it). No npm deps — plain fetch.
//
// Usage:
//   node collect-serpapi.mjs --prompt "<text>" [--hl vi] [--gl vn] [--location "Hanoi, Vietnam"] \
//     --out cells/where_to_buy.google_ai_mode.json
// Prompt may also come from --prompt-file or stdin.

import { readFileSync } from 'node:fs'
import { toCitation, dedupeCitations, fetchWithRetry, isMainModule, writeOutput } from './collect-api.mjs'

export function parseArgs(argv) {
  const out = { prompt: null, promptFile: null, hl: null, gl: null, location: null, out: null, intent: null, platform: null }
  const keys = { prompt: 'prompt', 'prompt-file': 'promptFile', hl: 'hl', gl: 'gl', location: 'location', out: 'out', intent: 'intent', platform: 'platform' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    const rawKey = eq === -1 ? a.slice(2) : a.slice(2, eq)
    const key = keys[rawKey]
    if (!key) continue
    let val
    if (eq !== -1) val = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i]
    if (val !== undefined) out[key] = val
  }
  return out
}

// text_blocks[] → plain text (prefer reconstructed_markdown when present).
export function blocksToText(blocks) {
  const parts = []
  for (const b of blocks || []) {
    if (typeof b.snippet === 'string' && b.snippet) parts.push(b.snippet)
    for (const it of b.list || []) {
      if (typeof it === 'string') parts.push('- ' + it)
      else if (it && typeof it.snippet === 'string') parts.push('- ' + it.snippet)
    }
    if (typeof b.code === 'string' && b.code) parts.push(b.code)
  }
  return parts.join('\n\n').trim()
}

export function parseSerpApi(body, params = {}) {
  if (body.error) throw new Error(`SerpApi: ${body.error}`)
  const status = body.search_metadata?.status
  if (status && status !== 'Success') throw new Error(`SerpApi status: ${status}`)
  const md = typeof body.reconstructed_markdown === 'string' ? body.reconstructed_markdown.trim() : ''
  const rawText = md || blocksToText(body.text_blocks)
  const citations = dedupeCitations(
    (body.references || []).map((r) => toCitation(r.link, r.title)).filter(Boolean),
  )
  return {
    rawText,
    servedModel: null, // google_ai_mode: submitted as 'browser' with empty servedModel
    externalResponseId: body.search_metadata?.id ?? null,
    webSearchUsed: rawText.length > 0, // an AI-Mode answer always came from a web search
    citations,
    searchQueries: null,
    searchRequestCount: null,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null },
    costUsd: null, // SerpApi bills per search, not per token
    providerMeta: { via: 'serpapi', engine: 'google_ai_mode' },
    requestParams: { engine: 'google_ai_mode', hl: params.hl ?? null, gl: params.gl ?? null, location: params.location ?? null },
  }
}

export async function collect({ prompt, apiKey, hl, gl, location, fetchImpl = fetch }) {
  const ask = async (noCache) => {
    const url = new URL('https://serpapi.com/search')
    url.searchParams.set('engine', 'google_ai_mode')
    url.searchParams.set('q', prompt)
    url.searchParams.set('api_key', apiKey)
    if (hl) url.searchParams.set('hl', hl)
    if (gl) url.searchParams.set('gl', gl)
    if (location) url.searchParams.set('location', location)
    if (noCache) url.searchParams.set('no_cache', 'true')
    const res = await fetchWithRetry(url, undefined, { fetchImpl }) // key is in the query string; never logged by us
    const text = await res.text()
    if (!res.ok) throw new Error(`SerpApi ${res.status}: ${text.slice(0, 300)}`)
    return parseSerpApi(JSON.parse(text), { hl, gl, location })
  }
  // SerpApi caches an empty AI-Mode result the same as a real one, so a single failed attempt
  // makes that prompt look permanently uncollectable. One forced-fresh retry clears it.
  const first = await ask(false)
  return first.rawText ? first : ask(true)
}

export async function main(argv, env = process.env) {
  const a = parseArgs(argv)
  const apiKey = env.SERPAPI_API_KEY
  if (!apiKey) throw new Error('missing SERPAPI_API_KEY in the environment')
  const prompt = a.prompt ?? (a.promptFile ? readFileSync(a.promptFile, 'utf8') : readFileSync(0, 'utf8'))
  if (!prompt.trim()) throw new Error('empty prompt (pass --prompt, --prompt-file, or pipe via stdin)')

  const response = await collect({ prompt, apiKey, hl: a.hl, gl: a.gl, location: a.location })
  if (!response.rawText) throw new Error('SerpApi returned no AI-Mode answer text')
  if (!response.webSearchUsed) throw new Error('no answer — backend rejects webSearchUsed=false')
  // google_ai_mode is submitted as a 'browser' cell with an empty servedModel.
  return writeOutput({ out: a.out, response, intent: a.intent, platform: a.platform ?? 'google_ai_mode', prompt, collectionMethod: 'browser' })
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
