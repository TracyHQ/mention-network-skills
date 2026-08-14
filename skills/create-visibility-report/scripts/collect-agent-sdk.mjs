// Collect ONE BYOK cell with the **Claude Agent SDK** (@anthropic-ai/claude-agent-sdk),
// running on the user's LOCAL Claude subscription (Claude Pro/Max via the Claude Code
// login) — not a metered ANTHROPIC_API_KEY. One headless `query()` with the built-in
// WebSearch tool on; capture the final answer + the URLs the model cited.
//
// Why this exists alongside collect-api.mjs: that one bills per token against a provider
// key; this one reuses a subscription the user already pays for, so collection is free.
// It only covers the `claude` platform (that's what this SDK drives); use the vendor
// agent CLIs (codex / gemini) for the other platforms, or collect-api.mjs for a metered key.
//
// Auth: the Agent SDK resolves credentials with ANTHROPIC_API_KEY *ahead* of the
// subscription OAuth, so by default we unset it (and ANTHROPIC_AUTH_TOKEN) for this
// process to guarantee the subscription is used. Pass --allow-api-key to keep them.
//
// The `@anthropic-ai/claude-agent-sdk` package + a logged-in `claude` CLI must be present;
// it is imported dynamically so `shared/` keeps its no-install default. If it's missing we
// say so and point at the CLI / API-key routes.
//
// Usage:
//   node collect-agent-sdk.mjs --prompt "<text>" [--model <id>] --out cell-response.json
// Prompt may also come from --prompt-file or stdin. Output is the cell's `response` object.
//
// NOTE on the payload (resolved 2026-07-29, backend issue #294): the SDK message stream always
// reports the model it actually used (`message.model`, captured below) — that IS an observation,
// not a guess, exactly like an API call's servedModel. So this collector now submits
// collectionMethod:'cli' with THAT model as servedModel, and the backend validator checks it
// against requiredServedModel same as the 'api' lane. Before #294, collectionMethod only had
// 'api'|'browser', so a cli/subscription cell had to lie and say 'browser' just to avoid
// SERVED_MODEL_MISMATCH — which meant the one lane where the agent picks its own model was the
// one lane nobody verified (measured for real: a run silently switched gemini-3.5-flash →
// gemini-3.6-flash under the old 'browser' cover). If for some reason `message.model` is ever
// missing, we fall back to the old collectionMethod:'browser' + empty servedModel rather than
// submitting a lie.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toCitation, dedupeCitations, isMainModule, writeOutput } from './collect-api.mjs'
import { extractCitations } from './collect-cli.mjs'

export function parseArgs(argv) {
  const out = { prompt: null, promptFile: null, model: null, out: null, allowApiKey: false, intent: null, platform: null }
  const keys = { prompt: 'prompt', 'prompt-file': 'promptFile', model: 'model', out: 'out', intent: 'intent', platform: 'platform' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    if (a === '--allow-api-key') { out.allowApiKey = true; continue }
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

const WEB_SEARCH_RE = /web[_ ]?search/i

// Turn the Agent SDK's message stream (array of SDKMessage) into a cell `response`.
// Final text: prefer the result message's `result`, fall back to concatenated assistant
// text. Citations: web_search_result_location entries on assistant text blocks. webSearchUsed:
// any citation, or an observed WebSearch tool_use (the validator requires it be true).
export function extractFromMessages(messages) {
  let finalText = ''
  let assistantText = ''
  let webSearchUsed = false
  let usage = null
  let costUsd = null
  let externalResponseId = null
  let model = null
  const citations = []

  for (const m of messages || []) {
    if (m.type === 'assistant' && m.message) {
      if (m.message.model) model = m.message.model
      for (const b of m.message.content || []) {
        if (typeof b.text === 'string') assistantText += b.text
        if (WEB_SEARCH_RE.test(b.type || '') || (b.type === 'tool_use' && WEB_SEARCH_RE.test(b.name || ''))) {
          webSearchUsed = true
        }
        for (const c of b.citations || []) {
          const cit = toCitation(c.url, c.title)
          if (cit) { citations.push(cit); webSearchUsed = true }
        }
      }
    }
    if (m.type === 'result') {
      if (m.subtype && m.subtype !== 'success') throw new Error(`agent sdk result: ${m.subtype}`)
      if (typeof m.result === 'string') finalText = m.result
      if (m.usage) usage = m.usage
      if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd
      externalResponseId = m.session_id ?? m.uuid ?? externalResponseId
    }
  }

  const rawText = (finalText || assistantText).trim()
  // The SDK's WebSearch rarely attaches citation blocks — the model just writes the links in
  // the answer. Scrape those the same way collect-cli.mjs does, so the claude column isn't
  // reported as sourceless next to engines whose citations came from the same kind of text.
  const scraped = citations.length ? dedupeCitations(citations) : extractCitations(rawText)
  return {
    rawText,
    // The SDK told us which model actually answered — declare it as-is (#294: this is an
    // observation, not a self-serving guess, so it belongs in the checked 'cli' lane).
    servedModel: model ?? null,
    externalResponseId: externalResponseId ?? null,
    webSearchUsed,
    citations: scraped,
    searchQueries: null,
    searchRequestCount: null,
    usage: {
      inputTokens: usage?.inputTokens ?? usage?.input_tokens ?? null,
      outputTokens: usage?.outputTokens ?? usage?.output_tokens ?? null,
      cachedInputTokens: usage?.cache_read_input_tokens ?? null,
      reasoningTokens: null,
    },
    costUsd: costUsd == null ? null : String(costUsd),
    providerMeta: { via: 'claude-agent-sdk', model: model ?? null },
    requestParams: { tool: 'WebSearch' },
  }
}

// The SDK spawns a real Claude Code process, and that process loads the operator's machine
// context by default: `settingSources` omitted means user + project + local settings, and
// with 'project' among them the CLAUDE.md files come too. A cell collected that way answers
// as the operator's assistant (persona, house language, house rules) instead of as a plain
// shopper — measuring us, not the market. So every context door is shut explicitly, and the
// session runs from an empty scratch dir with nothing around it to discover.
export function buildQueryOptions({ model } = {}) {
  const options = { allowedTools: ['WebSearch'], permissionMode: 'bypassPermissions' }
  if (model) options.model = model
  return {
    ...options,
    settingSources: [], // no settings.json, no CLAUDE.md (needs 'project' to load)
    cwd: mkdtempSync(join(tmpdir(), 'mn-cell-')), // empty dir: nothing to discover
    tools: ['WebSearch'], // base tool set: without this, Bash/Read/Write stay loaded and the
                          // model offers to go read local files instead of searching the web

    plugins: [],
    skills: [],
    agents: {},
    mcpServers: {},
    hooks: {},
  }
}

// Vars Claude Code exports into its children; they re-announce the host session to the
// spawned process. HOME stays: the subscription login lives there.
//
// Not every CLAUDE_* var is session identity, so the sweep has to spare two families or it
// breaks the run in ways that do not look like a scrub bug:
//   - CLAUDE_CODE_OAUTH_TOKEN (and its _FILE_DESCRIPTOR form) is how a headless/CI machine
//     authenticates at all. Drop it and the child reports a login failure.
//   - CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX / _USE_FOUNDRY / _USE_MANTLE / the matching
//     _SKIP_*_AUTH flags and _CLIENT_CERT select the provider endpoint. Dropping those is
//     worse than failing: the child silently falls back to the default endpoint and still
//     answers, on a different account.
const KEEP_ENV = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_|SKIP_|CLIENT_CERT|MAX_OUTPUT_TOKENS)/
export function scrubContextEnv(env) {
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE') && !KEEP_ENV.test(k)) delete env[k]
  }
  return env
}

// #294: 'cli' is the checked lane (servedModel must match requiredServedModel); 'browser' is the
// old unchecked fallback for when we genuinely don't know the model. Exported so the mapping is
// unit-testable without spinning up the whole SDK flow.
export function collectionMethodFor(response) {
  return response.servedModel ? 'cli' : 'browser'
}

export async function runQuery(prompt, { model, importSdk } = {}) {
  let sdk
  try {
    sdk = importSdk ? await importSdk() : await import('@anthropic-ai/claude-agent-sdk')
  } catch {
    throw new Error(
      "agent-sdk collector needs '@anthropic-ai/claude-agent-sdk' installed and a `claude` " +
      'CLI logged into your subscription. Run `npm i @anthropic-ai/claude-agent-sdk` (and ' +
      '`claude` login), or use the vendor CLI / API-key route instead.'
    )
  }
  const options = buildQueryOptions({ model })
  const messages = []
  try {
    for await (const m of sdk.query({ prompt, options })) messages.push(m)
  } finally {
    if (options.cwd) rmSync(options.cwd, { recursive: true, force: true })
  }
  return messages
}

export async function main(argv, env = process.env, { importSdk } = {}) {
  const a = parseArgs(argv)
  if (!a.allowApiKey) {
    // Force the subscription: these outrank subscription OAuth in the SDK's precedence.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  }
  scrubContextEnv(env)
  const prompt = a.prompt ?? (a.promptFile ? readFileSync(a.promptFile, 'utf8') : readFileSync(0, 'utf8'))
  if (!prompt.trim()) throw new Error('empty prompt (pass --prompt, --prompt-file, or pipe via stdin)')

  const messages = await runQuery(prompt, { model: a.model, importSdk })
  const response = extractFromMessages(messages)
  if (!response.rawText) throw new Error('agent sdk returned no text')
  if (!response.webSearchUsed) {
    throw new Error('web search did not run — backend rejects webSearchUsed=false. Retry, or collect this cell another way.')
  }
  // #294: 'cli' when the SDK told us the model (the normal case), 'browser' fallback otherwise.
  return writeOutput({ out: a.out, response, intent: a.intent, platform: a.platform ?? 'claude', prompt, collectionMethod: collectionMethodFor(response) })
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
