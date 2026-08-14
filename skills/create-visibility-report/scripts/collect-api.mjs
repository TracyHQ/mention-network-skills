// Collect ONE BYOK cell via a provider API (web-search on), normalized to the
// shape `submit_byok_check` expects for a cell's `response`. No SDK / no npm
// install — plain global fetch (Node ≥18), same ethos as ../render.mjs.
//
// Only the providers with a first-class web-search API live here: `openai` and
// `gemini`. `claude` and `google_ai_mode` are collected in the browser (driven
// by the agent per the live `get_byok_skill` playbook), not by this script.
//
// The backend validator (byok-validate.util.ts) is strict, so this script's job
// is to return a response that passes it:
//   - servedModel MUST equal the grid's apiModelId for the platform  → we echo
//     back the exact `--model` we were told to use.
//   - webSearchUsed MUST be true                                     → we force
//     the web-search tool on and detect that a search actually happened; if it
//     did not, we throw instead of submitting a cell that would be rejected.
//
// Usage:
//   node collect-api.mjs --provider openai --model <servedModel> \
//        --prompt-file prompt.txt --out cell-response.json
// Prompt may also come from --prompt "<text>" or stdin. Output is written to
// --out (and echoed to stdout); it is the `response` object for one cell.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// `import.meta.url === pathToFileURL(process.argv[1]).href` breaks silently — no error, exit 0,
// `main()` never runs — when the script is reached through a symlink: `.claude/skills/*` here is
// a symlink into `agent-pack/skills/*`, and Node's ESM loader resolves import.meta.url through
// the symlink target while process.argv[1] keeps the path actually invoked. realpath both sides.
// Exported so the sibling collectors (collect-cli/collect-agent-sdk/collect-serpapi), which
// already import from this file, share one implementation instead of re-copying it.
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(moduleUrl)
  } catch {
    return false
  }
}

export function parseArgs(argv) {
  const out = { provider: null, model: null, prompt: null, promptFile: null, out: null, intent: null, platform: null }
  const keys = { provider: 'provider', model: 'model', prompt: 'prompt', 'prompt-file': 'promptFile', out: 'out', intent: 'intent', platform: 'platform' }
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

// data:… and relative junk are not real citations; keep only http(s).
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}
export function toCitation(url, title) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  const domain = domainOf(url)
  const c = { url }
  if (domain) c.domain = domain
  if (title) c.title = title
  return c
}
export function dedupeCitations(list) {
  const seen = new Set()
  const out = []
  for (const c of list) {
    if (!c || seen.has(c.url)) continue
    seen.add(c.url)
    out.push(c)
  }
  return out
}

// Provider APIs throw transient 429/5xx (measured: Gemini returns 503 "high demand"
// mid-batch). Retry those with exponential backoff so one hiccup doesn't sink a cell.
// A retryable status is 429 or ≥500; anything else (incl. 4xx auth errors) returns as-is
// for the caller to surface. Honors Retry-After when the server sends it.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function fetchWithRetry(
  url,
  init,
  { retries = 3, baseDelayMs = 800, fetchImpl = fetch, sleepImpl = sleep } = {},
) {
  let lastErr
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetchImpl(url, init)
    } catch (e) {
      lastErr = e
      if (attempt >= retries) throw e
      await sleepImpl(baseDelayMs * 2 ** attempt)
      continue
    }
    if (res.status !== 429 && res.status < 500) return res
    if (attempt >= retries) return res // exhausted: let caller read the error body
    const ra = Number(res.headers?.get?.('retry-after'))
    await sleepImpl(Number.isFinite(ra) && ra > 0 ? ra * 1000 : baseDelayMs * 2 ** attempt)
  }
  // eslint-disable-next-line no-unreachable
  throw lastErr
}

// A submit_byok_check cell is `{ intentSlug, platformSlug, promptText, collectionMethod,
// response }`. Collectors return only the `response`; callers used to wrap it by hand.
// When a script is told its `--intent`/`--platform`, it can emit the whole cell so the
// output drops straight into a cells/ dir that submit.mjs reads without any wrapping.
export function toCell({ intentSlug, platformSlug, promptText, collectionMethod, response }) {
  return { intentSlug, platformSlug, promptText, collectionMethod, response }
}

// Write `--out` (full cell when intent+platform are known, else the bare response for
// back-compat) and return whatever was written. Central so every collector behaves alike.
export function writeOutput({ out, response, intent, platform, prompt, collectionMethod }) {
  const payload =
    intent && platform
      ? toCell({ intentSlug: intent, platformSlug: platform, promptText: prompt, collectionMethod, response })
      : response
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(payload, null, 2))
  }
  return payload
}

// ---- OpenAI Responses API (web_search tool) --------------------------------
// https://api.openai.com/v1/responses — output[] holds web_search_call items +
// a message whose content carries url_citation annotations.
export function parseOpenAI(body, requestedModel) {
  const output = Array.isArray(body.output) ? body.output : []
  const searchCalls = output.filter((o) => o.type === 'web_search_call')
  const citations = []
  let rawText = ''
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (typeof part.text === 'string') rawText += part.text
      for (const ann of part.annotations || []) {
        if (ann.type === 'url_citation') {
          const c = toCitation(ann.url, ann.title)
          if (c) citations.push(c)
        }
      }
    }
  }
  if (!rawText && typeof body.output_text === 'string') rawText = body.output_text
  const searchQueries = searchCalls
    .map((s) => s.action?.query)
    .filter((q) => typeof q === 'string' && q.length)
  const webSearchUsed = searchCalls.length > 0 || citations.length > 0
  const u = body.usage || {}
  return {
    rawText: rawText.trim(),
    servedModel: requestedModel, // must match grid apiModelId, not body.model
    externalResponseId: body.id ?? null,
    webSearchUsed,
    citations: dedupeCitations(citations),
    searchQueries: searchQueries.length ? searchQueries : null,
    searchRequestCount: searchCalls.length || null,
    usage: {
      inputTokens: u.input_tokens ?? null,
      outputTokens: u.output_tokens ?? null,
      cachedInputTokens: u.input_tokens_details?.cached_tokens ?? null,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? null,
    },
    costUsd: null, // client's own key; backend does not read this into llm_calls
    providerMeta: { apiModel: body.model ?? null },
    requestParams: { model: requestedModel, tool: 'web_search' },
  }
}

export async function collectOpenAI({ model, prompt, apiKey, fetchImpl = fetch }) {
  const res = await fetchWithRetry('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: prompt, tools: [{ type: 'web_search' }] }),
  }, { fetchImpl })
  const text = await res.text()
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`)
  return parseOpenAI(JSON.parse(text), model)
}

// ---- Gemini generateContent (google_search grounding) ----------------------
export function parseGemini(body, requestedModel) {
  const cand = body.candidates?.[0] || {}
  const parts = cand.content?.parts || []
  const rawText = parts.map((p) => p.text).filter((t) => typeof t === 'string').join('').trim()
  const gm = cand.groundingMetadata || {}
  const chunks = gm.groundingChunks || []
  const citations = []
  for (const ch of chunks) {
    const c = toCitation(ch.web?.uri, ch.web?.title)
    if (c) citations.push(c)
  }
  const searchQueries = Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries.filter(Boolean) : []
  const webSearchUsed = chunks.length > 0 || searchQueries.length > 0
  const u = body.usageMetadata || {}
  return {
    rawText,
    servedModel: requestedModel,
    externalResponseId: body.responseId ?? null,
    webSearchUsed,
    citations: dedupeCitations(citations),
    searchQueries: searchQueries.length ? searchQueries : null,
    searchRequestCount: searchQueries.length || null,
    usage: {
      inputTokens: u.promptTokenCount ?? null,
      outputTokens: u.candidatesTokenCount ?? null,
      cachedInputTokens: u.cachedContentTokenCount ?? null,
      reasoningTokens: u.thoughtsTokenCount ?? null,
    },
    costUsd: null,
    providerMeta: { apiModel: body.modelVersion ?? null },
    requestParams: { model: requestedModel, tool: 'google_search' },
  }
}

export async function collectGemini({ model, prompt, apiKey, fetchImpl = fetch }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
  }, { fetchImpl })
  const text = await res.text()
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`)
  return parseGemini(JSON.parse(text), model)
}

const PROVIDERS = {
  openai: { collect: collectOpenAI, keyEnv: 'OPENAI_API_KEY' },
  gemini: { collect: collectGemini, keyEnv: 'GEMINI_API_KEY' },
}

export async function main(argv, env = process.env) {
  const a = parseArgs(argv)
  const provider = PROVIDERS[a.provider]
  if (!provider) throw new Error(`--provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`)
  if (!a.model) throw new Error('--model <servedModel> is required (use the grid apiModelId for this platform)')
  const apiKey = env[provider.keyEnv]
  if (!apiKey) throw new Error(`missing ${provider.keyEnv} in the environment`)
  const prompt = a.prompt ?? (a.promptFile ? readFileSync(a.promptFile, 'utf8') : readFileSync(0, 'utf8'))
  if (!prompt.trim()) throw new Error('empty prompt (pass --prompt, --prompt-file, or pipe via stdin)')

  const response = await provider.collect({ model: a.model, prompt, apiKey })
  if (!response.rawText) throw new Error('provider returned no text')
  if (!response.webSearchUsed) {
    throw new Error('web search did not run — backend rejects webSearchUsed=false. Retry, or collect this cell in the browser.')
  }
  // openai → chatgpt, gemini → gemini; both are `api` cells.
  const platform = a.platform ?? (a.provider === 'openai' ? 'chatgpt' : a.provider)
  return writeOutput({ out: a.out, response, intent: a.intent, platform, prompt, collectionMethod: 'api' })
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
