// Collect ONE BYOK cell by driving a **vendor agent CLI** signed into the user's own
// subscription (route B2) — no API key, no per-token cost. This is the sibling of
// collect-api.mjs (metered key) and collect-agent-sdk.mjs (Claude Agent SDK): those had
// scripts, B2 did not, so callers hand-wrote the CLI plumbing every run. This is it.
//
//   engine → CLI           covers        model shown?
//   chatgpt → `codex exec`  chatgpt        no (auto-router)
//   claude  → `claude -p`   claude         n/a
//   gemini  → `gemini -p`   gemini         — see auth note
//
// NOTE on `gemini` — THREE failure modes that look alike and are not. Two machines measured
// this differently on 2026-07-28 and each generalised its own result, so state the condition,
// never the conclusion:
//
//   1. Auth (`IneligibleTierError` → "migrate to Antigravity"). Google retired the free
//      "Code Assist for individuals" OAuth tier, so `security.auth.selectedType:
//      "oauth-personal"` throws — *unless* the account has a Cloud project attached, i.e.
//      GOOGLE_CLOUD_PROJECT is exported (measured: with it set, oauth-personal answered fine
//      and collected a full 5-cell grid). Without one, switch `~/.gemini/settings.json` to
//      `"gemini-api-key"` and export GEMINI_API_KEY — note GEMINI_DEFAULT_AUTH_TYPE does NOT
//      override a settings.json that still says oauth-personal, measured, it still threw.
//      Or skip the CLI and collect gemini via collect-api.mjs (route B3).
//
//   2. Capacity (429 MODEL_CAPACITY_EXHAUSTED). Even on a working account the CLI's DEFAULT
//      model can be starved: "No capacity available for model gemini-3.5-flash" from
//      cloudcode-pa.googleapis.com. The CLI retries with backoff instead of failing, so a
//      2-word prompt burns 285s at 0% CPU and reads as a hang or a slow network. Pass
//      `--model gemini-2.5-pro` — same prompt, 9s; real search cells 23-54s. Quota is a red
//      herring: it fires well inside a 1500/day, 60/min allowance, because the exhausted
//      capacity is Google's, not yours. Diagnose from RAW stderr — the CLI surfaces only
//      "An unexpected critical error occurred:[object Object]".
//
//   3. Trust ("not running in a trusted directory"). Headless runs abort before reaching the
//      model in a directory the user never trusted — which our clean-room temp dir never is.
//      `--skip-trust` is therefore mandatory here, not optional.
//
// Route choice: on API-key auth this spends the same AI Studio key as collect-api.mjs, on more
// tokens (agent loop vs one call). Prefer this when you want the agent lane uniform across all
// three engines; prefer collect-api.mjs when you want gemini parallel, cheap and with a real
// servedModel. See SETUP-ROUTES.md.
//
// #294 (resolved 2026-07-29) — servedModel / collectionMethod. `--model` above was added for a
// DIFFERENT reason (routing around a starved gemini default), but it has a second consequence:
// once the caller names the model, that name is an OBSERVATION, not a guess — exactly like an
// API call's servedModel — so it belongs in the CHECKED lane. `claude`/`gemini` now also accept
// `--model` for THIS reason, and when one is given the cell declares `collectionMethod:'cli'`
// with that model as `servedModel`, checked by the backend against `requiredServedModel` (same
// rule as the `api` lane). Before #294, `collectionMethod` only had `'api'|'browser'`, so every
// CLI cell — including ones where `--model` was already known — had to claim `'browser'` just to
// avoid `SERVED_MODEL_MISMATCH`, which is exactly how a real run silently switched
// `gemini-3.5-flash` → `gemini-3.6-flash` on a 503 with nothing to catch it. Since ADR-0036, that
// check is a WARNING, not a block: a mismatch no longer fails the submit, but `servedModel` is
// still stored and shown exactly as declared — so declaring it accurately still matters, it just
// isn't a rejection anymore. `chatgpt`/`codex exec` stays an auto-router with no controllable
// model, so it (and any call without --model) still submits `collectionMethod:'browser'` + empty
// `servedModel` — unchanged, and still the honest thing to declare when the model genuinely isn't
// known. webSearchUsed is true because we pass each CLI its web-search flag. Citations are
// scraped from the answer's markdown/bare URLs (map/CDN chrome dropped).
//
// Web search DID run only if you enabled it; these CLIs default it off, so we pass the flag.
// If the answer comes back with zero citations AND is short, we warn on stderr (the free
// Gemini UI legitimately returns none, so it is a warning, not a throw).
//
// Usage:
//   printf '%s' "<prompt>" | node collect-cli.mjs --engine chatgpt \
//     --intent where_to_buy --out cells/where_to_buy.chatgpt.json
//   printf '%s' "<prompt>" | node collect-cli.mjs --engine gemini --model gemini-3.6-flash \
//     --intent where_to_buy --out cells/where_to_buy.gemini.json
//   (--model is illustrative — always pass the LIVE requiredServedModel from describe_check_grid,
//   never hardcode it: the catalog default changed gemini-2.5-pro→3.5-flash→3.6-flash already,
//   with 3.5-flash now the managed lane's in-platform fallback, see the fallback ADR.)
// Prompt may also come from --prompt / --prompt-file. With --intent, --out is a full cell;
// without it, the bare `response` (same convention as the other collectors). `--model <id>`
// is optional (claude/gemini only — see #294 note above): pass the grid's requiredServedModel
// from describe_check_grid so the cell is collected on the exact free-tier model and declared
// checkable (`collectionMethod:'cli'`); omit it and the cell falls back to the old
// `collectionMethod:'browser'` + empty servedModel.

import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { toCitation, dedupeCitations, isMainModule, writeOutput } from './collect-api.mjs'

// Every vendor CLI auto-loads project context (AGENTS.md / CLAUDE.md / GEMINI.md) by walking UP
// from its working directory. Inherit our cwd and a cell collected from inside the repo arrives
// pre-briefed on the merchant it is supposed to be grading — measured: `codex exec` quoted this
// repo's AGENTS.md and burned ~2.5k extra tokens on it. Run every CLI from an empty temp dir so
// there is nothing to walk up to. Created once per process; the OS reclaims it.
let neutralCwd
function cleanRoom() {
  if (!neutralCwd) neutralCwd = mkdtempSync(join(tmpdir(), 'mn-collect-'))
  return neutralCwd
}

export function parseArgs(argv) {
  // null = "caller said nothing", so main() can fall back to the engine's own default. A literal
  // 180000 here would look identical to an explicit --timeout-ms 180000 and override that default.
  const out = { engine: null, prompt: null, promptFile: null, intent: null, platform: null, out: null, timeoutMs: null, model: null }
  const keys = {
    engine: 'engine', prompt: 'prompt', 'prompt-file': 'promptFile',
    intent: 'intent', platform: 'platform', out: 'out', 'timeout-ms': 'timeoutMs',
    model: 'model',
  }
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
    if (val !== undefined) out[key] = key === 'timeoutMs' ? Number(val) : val
  }
  return out
}

// UI chrome / tiles / schema hosts — never a real merchant source.
const DROP = /(mapbox|openstreetmap|google\.[a-z.]+\/maps|\/maps\/|gstatic|googleusercontent|schema\.org|w3\.org|bing\.com\/maps)/i
export function extractCitations(text) {
  const urls = new Set()
  for (const m of String(text).matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) urls.add(m[1]) // markdown [t](url)
  for (const m of String(text).matchAll(/(?<![([])\bhttps?:\/\/[^\s)\]]+/g)) urls.add(m[0]) // bare
  const cites = []
  for (let u of urls) {
    u = u.replace(/[.,;]+$/, '') // strip trailing punctuation
    if (DROP.test(u)) continue
    const c = toCitation(u)
    if (c) cites.push(c)
  }
  return dedupeCitations(cites)
}

export const DEFAULT_TIMEOUT_MS = 180000

// Each runner takes (prompt, timeoutMs, model) → the assistant's final answer as plain text, with
// its own web-search flag on. Flags drift between CLI versions; these are the 2026-07 forms.
// An engine may raise its own ceiling via defaultTimeoutMs; --timeout-ms still overrides it.
//
// `model` (optional, #294): when the caller passes --model and the engine's CLI can actually be
// pinned to it, we pass the flag through and the cell can honestly declare that servedModel —
// checked by the backend. `chatgpt` ignores it here: `codex exec`'s free/plan lane is an
// auto-router (see the header table), so there is nothing verified to declare even if a model
// string were passed — pinning it would be exactly the kind of unverifiable claim this validator
// exists to catch, so we deliberately never wire `model` into the codex args.
// The query an engine actually SENDS to web search is not the shopper's question — measured
// 2026-08 across 770 responses, models rewrite it (drop the location entirely a third of the
// time — synonyms like USA/UAE counted as kept, not dropped — and inject
// incumbent retailer names into 21%). That rewrite is the single strongest observable signal we
// have for why a merchant is missing from an answer, so the cell has to carry it.
//
// Text mode cannot: it only ever shows the final prose. Every CLI here has a structured mode that
// emits the tool call, and each spells it differently — shapes below were captured from real runs
// on 2026-08-11, not read off documentation:
//
//   codex  --json                 {"type":"item.completed","item":{"type":"web_search","query":…}}
//   claude --output-format        {"type":"assistant","message":{"content":[
//          stream-json --verbose     {"type":"tool_use","name":"WebSearch","input":{"query":…}}]}}
//   gemini --output-format        {"type":"tool_use","tool_name":"google_web_search",
//          stream-json               "parameters":{"query":…}}
//
// All three are converted. Where each keeps the FINAL ANSWER differs too, and gemini is the odd
// one — see extractCliAnswerText below.
//
// Returns the queries RAW: in arrival order, duplicates kept. A model that runs the same query
// twice really did search twice, and searchRequestCount has to say 2 — the api-lane adapters
// (claude/gemini) count un-deduped, so deduping here would make the same column mean two different
// things depending on which lane collected the cell. Dedupe belongs at the storage step
// (buildResponse), not here.
export function extractCliSearchQueries(engine, stream) {
  const out = []
  for (const ev of parseEvents(stream)) {
    if (engine === 'chatgpt') {
      // item.started fires with query:"" before the search resolves — only completed carries it.
      if (ev.type === 'item.completed' && ev.item?.type === 'web_search' && ev.item.query) out.push(ev.item.query)
      continue
    }
    if (engine === 'claude') {
      for (const b of ev.message?.content ?? []) {
        if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && /^web_?search$/i.test(b.name ?? '') && b.input?.query) out.push(b.input.query)
      }
      continue
    }
    if (engine === 'gemini') {
      // Flat event, not nested in a message: tool_name + parameters at the top level.
      if (ev.type === 'tool_use' && /web_?search/i.test(ev.tool_name ?? '') && ev.parameters?.query) out.push(ev.parameters.query)
    }
  }
  return out
}

// The finished answer, pulled out of the same stream. Exported so the runners and the tests call
// the SAME code: a test that re-implements this loop inline passes even after the runner breaks.
//
//   codex   last item.completed/agent_message — the FIRST one is the model narrating what it is
//           about to do, so taking [0] submits a preamble as the answer
//   claude  one {"type":"result","result":"<text>"} at the end
//   gemini  no finished-answer event at all (its `result` holds only status/stats): the text is
//           the assistant `message` chunks joined in arrival order. role must be checked — the
//           first `message` echoes the USER prompt back, and joining that submits the question
//           as if it were the answer.
export function extractCliAnswerText(engine, stream) {
  let text = ''
  for (const ev of parseEvents(stream)) {
    if (engine === 'chatgpt') {
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text = ev.item.text
    } else if (engine === 'claude') {
      if (ev.type === 'result' && typeof ev.result === 'string') text = ev.result
    } else if (engine === 'gemini') {
      if (ev.type === 'message' && ev.role === 'assistant' && ev.delta && typeof ev.content === 'string') text += ev.content
    }
  }
  return text.trim()
}

// A killed or timed-out CLI leaves a half-written last line. Dropping it beats throwing away the
// whole cell over a cosmetic parse error.
function* parseEvents(stream) {
  for (const line of String(stream ?? '').split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      yield JSON.parse(s)
    } catch {
      continue
    }
  }
}

export const ENGINES = {
  chatgpt: {
    platform: 'chatgpt',
    run(prompt, timeoutMs) {
      const instr = `You are a helpful shopping assistant. Use web search to answer this shopper question accurately, then give a concise answer naming specific stores/retailers with their links. Question: ${prompt}`
      // --json turns stdout into the event stream (it was previously discarded via stdio:'ignore').
      // The final answer is the LAST item.completed/agent_message — the first one is the model
      // narrating what it is about to do, so taking [0] would submit a preamble as the answer.
      // project_doc_max_bytes=0 stops codex reading AGENTS.md even if one exists in the cwd.
      const stream = execFileSync('codex', ['exec', '--json', '-c', 'tools.web_search=true', '-c', 'project_doc_max_bytes=0', '--skip-git-repo-check', '-s', 'read-only', instr], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, cwd: cleanRoom() })
      return { text: extractCliAnswerText('chatgpt', stream), searchQueries: extractCliSearchQueries('chatgpt', stream) }
    },
  },
  claude: {
    platform: 'claude',
    run(prompt, timeoutMs, model) {
      const instr = `Use web search to answer this shopper question, then give a concise answer naming specific stores/retailers with their links. Question: ${prompt}`
      // Force the subscription (not a metered key) for this child process.
      const env = { ...process.env }
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      // --setting-sources '' is the CLI twin of the SDK's settingSources: []. A neutral cwd alone
      // is NOT enough here — the user-scoped ~/.claude/CLAUDE.md loads from any directory.
      //
      // --strict-mcp-config drops every MCP server the operator has configured (we pass no
      // --mcp-config, so it ends up with none). Without it the answer text itself leaks the
      // operator's setup: a measured cell ended with "Note: two MCP servers (claude.ai,
      // LangChain) in this session need authorization" — machine state narrated to the model and
      // submitted as the shopper's own words. Note this is a SEPARATE leak from CLAUDE.md;
      // --setting-sources does not suppress it.
      //
      // stream-json (+ --verbose, which it requires) is what exposes the tool call carrying the
      // rewritten search query. The final answer text stays recoverable: the stream ends with a
      // single {"type":"result","result":"<text>"} event.
      const args = ['-p', instr, '--allowedTools', 'WebSearch', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose']
      // #294: pin the model when the caller named one, so the cell can declare it as a real,
      // checked servedModel instead of an unverifiable guess.
      if (model) args.push('--model', model)
      const stream = execFileSync('claude', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env, cwd: cleanRoom() })
      return { text: extractCliAnswerText('claude', stream), searchQueries: extractCliSearchQueries('claude', stream) }
    },
  },
  gemini: {
    platform: 'gemini',
    // Measured 2026-07: a real search-and-answer cell overran the shared 180s ceiling and died
    // with ETIMEDOUT; 7 min was comfortable. Gemini is simply slower than codex/claude here, so
    // it gets its own default instead of forcing every caller to remember --timeout-ms.
    defaultTimeoutMs: 420000,
    run(prompt, timeoutMs, model) {
      // Name the builtin tool: "web search" is a description, `google_web_search` is the tool
      // gemini actually has, and asking for it by name stops the model narrating a search it
      // never ran.
      const instr = `Use google_web_search to answer this shopper question, then give a concise answer naming specific stores/retailers with their links. Question: ${prompt}`
      // No context-suppression flag exists on gemini as of CLI 0.52, so the neutral cwd is the
      // whole defence: it hides a project GEMINI.md/AGENTS.md. Nothing shields a global
      // ~/.gemini/GEMINI.md — none exists on this machine; re-probe if that ever changes.
      //
      // --skip-trust is REQUIRED once we set cwd: gemini refuses to run in a directory the user
      // has not trusted, and a freshly-minted temp dir never is. Safe here precisely because the
      // dir is empty — trust exists to stop the CLI acting on unvetted project files, and there
      // are none. Drop this flag and every gemini cell dies with a trusted-folder error.
      // Pass --model when the caller picked one. Worth knowing WHY you'd want to: the CLI's
      // default model can be capacity-starved server-side while another is idle. Measured
      // 2026-07 on Code Assist — the endpoint answered a plain `say ok` with
      //   429 "No capacity available for model gemini-3.5-flash" (MODEL_CAPACITY_EXHAUSTED)
      // and the CLI's own retryWithBackoff turned that into a 285s wall-clock hang at 0% CPU.
      // `-m gemini-2.5-pro` answered the same prompt in 9s. So when gemini looks "slow", suspect
      // a starved default model before you suspect your quota — and read raw stderr, because the
      // CLI's surfaced message is only "An unexpected critical error occurred:[object Object]".
      // Naming the model here ALSO makes it a real, checked servedModel (#294) — not just a
      // capacity workaround.
      // -o text: final answer only, no event stream to parse back out.
      // stream-json instead of text, for the same reason as the other two: it is the only mode
      // that shows the rewritten search query. Unlike claude/codex, gemini has NO event carrying
      // the finished answer — its `type:"result"` holds only status/stats — so the text is the
      // assistant `message` chunks concatenated in arrival order. They are explicitly flagged
      // `delta:true`, so this is a plain join, not a guess at which event is final.
      const args = ['--skip-trust', '-o', 'stream-json', '-p', instr]
      if (model) args.push('-m', model)
      const stream = execFileSync('gemini', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, cwd: cleanRoom() })
      return { text: extractCliAnswerText('gemini', stream), searchQueries: extractCliSearchQueries('gemini', stream) }
    },
  },
}

// A vendor CLI writes its real cause to stderr, which execFileSync buries on the thrown error
// rather than printing. Surface it, and only then add a hint that matches the failure we actually
// saw. The previous version hard-coded one hint per engine, so a gemini timeout and a gemini
// trusted-folder refusal both got blamed on a retired OAuth tier — sending the reader to fix
// something that was never broken.
export function describeCliFailure(e, engine, timeoutMs) {
  const stderr = String(e.stderr ?? '').replace(/\[\d+m/g, '').trim()
  // Last *informative* stderr line, not merely the last one: these CLIs often finish by dumping a
  // JSON error object whose final line is a bare "}" — measured, a real gemini timeout reported
  // its cause as exactly that. Require some length and a letter, and drop lines that are only JSON
  // scaffolding or a bare key. Fall back to the thrown message when nothing qualifies.
  const informative = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 8 && /[a-z]/i.test(l) && !/^[[\]{},]+$/.test(l) && !/^"[^"]*":\s*[[{]?,?$/.test(l))
  const cause = informative.pop() || String(e.message).split('\n')[0]
  const seconds = Math.round((timeoutMs ?? 0) / 1000)
  let hint
  if (e.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(cause)) {
    hint = `no answer within ${seconds}s — raise --timeout-ms and retry`
  } else if (e.code === 'ENOENT') {
    hint = `the ${engine} CLI is not on PATH — install it (see SETUP-ROUTES.md)`
  } else if (/trusted directory|trusted folder|--skip-trust/i.test(cause)) {
    hint = 'gemini refused the working directory — the --skip-trust flag is missing or was dropped'
  } else if (/log ?in|logged in|unauthenticated|401|auth/i.test(cause)) {
    hint = `run the ${engine} login flow, then retry`
  } else if (/MODEL_CAPACITY_EXHAUSTED|No capacity available/i.test(cause)) {
    hint = 'Google has no capacity for that model right now — pass --model gemini-2.5-pro'
  } else if (/IneligibleTierError|Antigravity/i.test(cause)) {
    hint = 'the free OAuth tier is retired: export GOOGLE_CLOUD_PROJECT, or set ~/.gemini/settings.json security.auth.selectedType to "gemini-api-key" with GEMINI_API_KEY, or collect gemini via collect-api.mjs'
  } else if (/quota|429|RESOURCE_EXHAUSTED/i.test(cause)) {
    hint = 'the account tier or quota rejected this call — try another route for this engine'
  } else {
    hint = `is the ${engine} CLI installed and logged in?`
  }
  return `${cause} (${hint})`
}

// #294: 'cli' is the checked lane (servedModel is compared against requiredServedModel — a
// mismatch is a warning since ADR-0036, not a rejection); 'browser' is the old unchecked fallback
// for engines/calls where the model genuinely isn't pinned/known. Exported so the mapping is
// unit-testable on its own.
export function collectionMethodFor(response) {
  return response.servedModel ? 'cli' : 'browser'
}

export function buildResponse(rawText, engine, model = null, searchQueries = null) {
  const citations = extractCitations(rawText)
  return {
    rawText,
    // #294: declare the pinned model when we have one (self-reported and CHECKED against
    // requiredServedModel, same trust model as the api lane) — empty only when truly unknown
    // (chatgpt/codex auto-router, or no --model passed).
    servedModel: model,
    externalResponseId: null,
    webSearchUsed: true, // we passed the web-search flag; the CLI ran it
    citations,
    // Empty array ⇒ the stream was read and the model genuinely ran no search; null ⇒ this engine
    // still runs in text mode so we never had the chance to look. Collapsing both to null would
    // hide which of the two it is, and that is exactly the distinction the report needs.
    //
    // Count comes from the RAW list, the stored list is deduped: repeating a query is two real
    // searches, and the api-lane adapters count un-deduped — deduping the count here would make
    // the same column mean different things depending on which lane collected the cell.
    searchQueries: searchQueries?.length ? [...new Set(searchQueries)] : null,
    searchRequestCount: searchQueries ? searchQueries.length : null,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null },
    costUsd: null, // subscription, not per-token
    providerMeta: { via: 'vendor-cli', engine },
    requestParams: { engine, tool: 'web_search' },
  }
}

export async function main(argv, env = process.env) {
  const a = parseArgs(argv)
  const spec = ENGINES[a.engine]
  if (!spec) throw new Error(`--engine must be one of: ${Object.keys(ENGINES).join(', ')}`)
  const prompt = a.prompt ?? (a.promptFile ? readFileSync(a.promptFile, 'utf8') : readFileSync(0, 'utf8'))
  if (!prompt.trim()) throw new Error('empty prompt (pass --prompt, --prompt-file, or pipe via stdin)')

  const timeoutMs = a.timeoutMs ?? spec.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  let result
  try {
    result = spec.run(prompt, timeoutMs, a.model)
  } catch (e) {
    throw new Error(`${a.engine} CLI failed: ${describeCliFailure(e, a.engine, timeoutMs)}`)
  }
  // A runner returns {text, searchQueries} once converted to structured output; the ones still on
  // plain text return a bare string. Normalising here keeps both shapes working during the switch
  // instead of forcing every engine over in one commit.
  const rawText = typeof result === 'string' ? result : result?.text
  const searchQueries = typeof result === 'string' ? null : (result?.searchQueries ?? null)
  if (!rawText) throw new Error(`${a.engine} CLI returned no answer text`)
  // chatgpt/codex has no controllable model (auto-router) — never claim one even if --model was
  // passed by mistake, so it always falls back to the unchecked 'browser' lane.
  const model = a.engine === 'chatgpt' ? null : a.model
  const response = buildResponse(rawText, a.engine, model, searchQueries)
  if (response.citations.length === 0 && rawText.length < 200) {
    process.stderr.write(`warning: ${a.engine} answer is short with 0 citations — verify web search actually ran before submitting\n`)
  }
  return writeOutput({ out: a.out, response, intent: a.intent, platform: a.platform ?? spec.platform, prompt, collectionMethod: collectionMethodFor(response) })
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
