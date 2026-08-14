# create-visibility-report — standalone Mention Network skill

Portable bundle of the `create-visibility-report` skill. Copy this folder into any Claude host
(Claude Code CLI, Claude Desktop, MN Studio) or install it as a plugin — it depends on
nothing from the Mention Network repo. The only external piece is the **hosted MCP**
(declared in `.mcp.json`).

## What it does
Probes everything first (MCP, stored keys, which routes work, the storefront catalog, recent runs),
then asks you at most three times — a confirm card, a prompt approval, an optional website audit —
each a click on pre-filled options. It also takes a one-line shorthand:

```
/create-visibility-report kbeautyarabia.com byok agent-sdk(chatgpt, claude, gemini) serpapi(google-ai-mode)
# same thing, inverse form — every token is order-free:
/create-visibility-report byok kbeautyarabia.com google_ai_mode=playwright chatgpt=agent-sdk country=SA
```

Two lanes produce the report:
- **Backend-run** — the Mention Network backend queries the AI providers on its own keys.
- **Self-collected (BYOK)** — you collect the answers and submit them. Every route is a
  **clean room**: a headless process with no chat memory, because a logged-in consumer chat UI
  personalizes the answer and the report would measure that account instead of the market. Routes
  are ranked **agent lane → API key**, and an impossible route/engine pair is repaired rather than
  rejected:
  the **agent lane** on your own subscription (`scripts/collect-agent-sdk.mjs` for Claude,
  `scripts/collect-cli.mjs` for `codex` / `claude` / `gemini`),
  a **provider API key** (`scripts/collect-api.mjs`),
  and — for Google AI Mode, which has no model API and is routed separately — **SerpApi**
  (`scripts/collect-serpapi.mjs`) or the signed-out **`playwright`** MCP.

The collectors write one cell file each; `skills/create-visibility-report/scripts/submit.mjs` validates a
`cells/` dir and submits it via `scripts/mcp-client.mjs` (no need to inline the payload by hand).
Optionally renders a branded multi-page PDF locally (`skills/create-visibility-report/shared/render.mjs`) or via the MCP's
`export_*_pdf` tools.

## Credentials (enter once, reuse)
Secrets live in a dotenv file **outside this bundle** — default `~/.config/mention-network/credentials`
(override with `$MENTION_NETWORK_CREDENTIALS`), `chmod 600`, managed by `skills/create-visibility-report/scripts/credentials.mjs`
(`status` / `save`, never prints a secret). Subscription CLI logins (claude/codex/gemini) reuse
their own native login. **The store is never written into this folder or the .tgz — don't commit it.**

## Requirements
Only what the routes you actually use need — and if an AI engine has no route yet, the skill walks you
through setting one up (`skills/create-visibility-report/SETUP-ROUTES.md`: the ranking + per-route
install/key/login, incl. the free ones) instead of shipping a partial 1-of-4-engines report.
- **Always:** `MENTION_NETWORK_KEY` (Bearer for the MCP). Log in at mention.network for a key.
- **Per self-collection route (only what you use):**
  - Agent lane: the vendor CLI installed & authenticated (`codex` / `claude` / `gemini`), and
    optionally `@anthropic-ai/claude-agent-sdk`. Free on an existing ChatGPT / Claude plan;
    `gemini` needs API-key auth (its free OAuth tier is retired — see SETUP-ROUTES.md).
  - API key: `OPENAI_API_KEY` (paid) and/or `GEMINI_API_KEY` (free tier).
  - `google_ai_mode`: `SERPAPI_API_KEY` (free ≈100 searches/month), or the `playwright` MCP
    on its signed-out profile.
- **Local PDF (optional):** Node ≥18 + Google Chrome.

## Install (Tracy Desk)

Published to the Tracy skill registry as `tracyhq/create-visibility-report`, so it installs with
one click: **Site Configuration → Skills → Add Skill → Online search → tracy.ai**, then enable it.

For a whole team at once, an admin puts the pointer in the site's team configuration instead —
every coworker on that site then gets the skill installed and enabled on their own machine, and
supplies only their own key:

```json
{
  "mcpServers": {
    "mention-network": {
      "type": "http",
      "url": "https://shopify-mcp-dev.mention.network/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${MENTION_NETWORK_KEY}" }
    }
  },
  "skills": ["tracyhq/create-visibility-report"]
}
```

`${MENTION_NETWORK_KEY}` must stay a placeholder: the key is entered per machine and never
travels to the team configuration.

## Install (Claude Code CLI)
```bash
export MENTION_NETWORK_KEY=<your-key>
# The bundled .mcp.json declares the mention-network MCP with ${MENTION_NETWORK_KEY}.
# Register the plugin/skill folder with your Claude host, then in Claude:
#   /create-visibility-report      (or: "create a visibility report for store <domain>")
```

## Layout
```
create-visibility-report/
├── .claude-plugin/plugin.json          plugin manifest (name: create-visibility-report)
├── .mcp.json                           hosted Mention Network MCP (Bearer ${MENTION_NETWORK_KEY})
├── skills/create-visibility-report/
│   ├── SKILL.md                         the skill — P0 parse → P1 preflight → 3 questions → report
│   ├── ARGUMENTS.md                     shorthand grammar, route ranking, repair rules
│   ├── SETUP-ROUTES.md                  route ranking + per-route install/key/login
│   ├── RECOVERY.md                      run directory, resume, error → fix
│   ├── ANALYSIS.md                      P4.5 client-side detection playbook
│   ├── COLLECT-PLAYWRIGHT.md            driving the browser, only if google_ai_mode=playwright
│   └── scripts/                         the skill's own scripts (zero-dep)
│       ├── collect-agent-sdk.mjs        BYOK collector — Claude Agent SDK (subscription)
│       ├── collect-cli.mjs              BYOK collector — codex / claude CLI (subscription)
│       ├── collect-api.mjs              BYOK collector — OpenAI/Gemini API key (metered)
│       ├── collect-serpapi.mjs          BYOK collector — SerpApi Google AI Mode (google_ai_mode)
│       ├── collect-pool.mjs             fans out collect-*.mjs across a grid with SKILL.md's concurrency caps
│       ├── mcp-client.mjs               minimal MCP JSON-RPC client
│       ├── submit.mjs                   validate a cells/ dir, then submit
│       ├── check-detections.mjs         re-checks P4.5 detection guards locally before validate
│       └── credentials.mjs              credential store (enter-once reuse; writes to $HOME, not here)
    └── shared/                          PDF renderer, vendored so a single-directory install keeps it
        ├── render.mjs                   report.json → Mustache → headless Chrome → PDF
        ├── templates/default/{report.html,report.css}
        ├── assets/  vendor/mustache.min.js
```

*Generated by `agent-pack/scripts/package-create-visibility-report.mjs` — edit the source in that repo, not this copy.*
