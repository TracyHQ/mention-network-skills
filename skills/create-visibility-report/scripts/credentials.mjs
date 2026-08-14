// Tiny credential store so the user enters a secret ONCE and create-visibility-report reuses it.
//
// Design + security boundary:
//   - The file lives OUTSIDE this bundle (default ~/.config/mention-network/credentials,
//     override with $MENTION_NETWORK_CREDENTIALS). It must never be inside the packaged
//     .tgz or a git repo — the packager copies only shared/*, never $HOME.
//   - dotenv format (`NAME=value` per line), so the skill loads it by *sourcing* it into the
//     shell for one command (`set -a; . "$CREDS"; set +a; node collect-*.mjs …`). Secrets
//     therefore reach the collectors via env, never through the agent's text context.
//   - This tool NEVER prints a secret. `save` reads each value from the ENVIRONMENT (not argv,
//     which would echo it), and `status` masks to the last 4 chars. There is deliberately no
//     `get` that prints raw values — consume them by sourcing the file.
//   - dir 0700, file 0600.
//
// Subscription logins (B1/B2: claude/codex/gemini) are NOT stored here — those CLIs persist
// their own login natively; nothing to save. This store is for the raw keys the collectors /
// MCP read from env: OPENAI_API_KEY, GEMINI_API_KEY, and MENTION_NETWORK_KEY.
//
// Usage:
//   node credentials.mjs status                 # masked list of what's stored
//   node credentials.mjs path                    # print the file path
//   OPENAI_API_KEY=sk-... node credentials.mjs save OPENAI_API_KEY [MORE...]
//
// Load into a shell for a collector run (the skill does this, not this tool):
//   CREDS="${MENTION_NETWORK_CREDENTIALS:-$HOME/.config/mention-network/credentials}"
//   set -a; [ -f "$CREDS" ] && . "$CREDS"; set +a

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// `import.meta.url === pathToFileURL(process.argv[1]).href` breaks silently — no error, exit 0,
// `main()` never runs — when the script is reached through a symlink: `.claude/skills/*` here is
// a symlink into `agent-pack/skills/*`, and Node's ESM loader resolves import.meta.url through
// the symlink target while process.argv[1] keeps the path actually invoked. realpath both sides.
function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(moduleUrl)
  } catch {
    return false
  }
}

export const KNOWN = ['MENTION_NETWORK_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'SERPAPI_API_KEY']

export function credsPath(env = process.env) {
  return env.MENTION_NETWORK_CREDENTIALS || join(homedir(), '.config', 'mention-network', 'credentials')
}

// Parse a dotenv-ish file: `NAME=value` lines; ignore blanks and `#` comments; first `=` splits.
export function parseEnv(text) {
  const map = new Map()
  for (const line of String(text).split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq === -1) continue
    const key = s.slice(0, eq).trim()
    let val = s.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) map.set(key, val)
  }
  return map
}

export function serializeEnv(map) {
  const header =
    '# Mention Network credentials — DO NOT COMMIT. Managed by create-visibility-report scripts/credentials.mjs.\n' +
    '# Loaded by create-visibility-report via: set -a; . "$CREDS"; set +a\n'
  const body = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  return header + (body ? body + '\n' : '')
}

export function mask(value) {
  if (typeof value !== 'string' || value.length === 0) return '(empty)'
  return value.length <= 4 ? '****' : '****' + value.slice(-4)
}

function readStore(env) {
  const p = credsPath(env)
  return existsSync(p) ? parseEnv(readFileSync(p, 'utf8')) : new Map()
}

function writeStore(map, env) {
  const p = credsPath(env)
  mkdirSync(dirname(p), { recursive: true })
  try { chmodSync(dirname(p), 0o700) } catch { /* best effort */ }
  writeFileSync(p, serializeEnv(map))
  chmodSync(p, 0o600)
  return p
}

export function statusLines(env = process.env) {
  const stored = readStore(env)
  return KNOWN.map((name) => {
    const inFile = stored.has(name)
    const inEnv = typeof env[name] === 'string' && env[name].length > 0
    const where = inFile ? `stored ${mask(stored.get(name))}` : inEnv ? `env only ${mask(env[name])}` : 'missing'
    return `${name}: ${where}`
  })
}

// Persist the given names, taking each value from the ENVIRONMENT (never argv).
export function save(names, env = process.env) {
  if (!names.length) throw new Error('save needs at least one NAME (value is read from the env of the same name)')
  const store = readStore(env)
  const saved = []
  for (const name of names) {
    const val = env[name]
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(`${name} is not set in the environment — export it first (so it is not echoed in argv), then save`)
    }
    store.set(name, val)
    saved.push(name)
  }
  const p = writeStore(store, env)
  return { path: p, saved }
}

export function main(argv, env = process.env) {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'status':
      return statusLines(env).join('\n')
    case 'path':
      return credsPath(env)
    case 'save': {
      const { path, saved } = save(rest, env)
      return `saved ${saved.join(', ')} → ${path} (chmod 600)`
    }
    default:
      throw new Error('usage: credentials.mjs <status|path|save NAME...>')
  }
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
