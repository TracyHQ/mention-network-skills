# Driving Playwright for `google_ai_mode`

Read this only when the route actually chosen for `google_ai_mode` is `playwright` — SerpApi is the
`(Recommended)` default and needs none of this. This file is about *operating* the browser once
you've decided to use it; getting the MCP registered and the profile verified signed-out is a setup
concern covered in `SETUP-ROUTES.md`.

The only browser route left, and it exists because Google AI Mode has no API and needs no account.

---

- **Keep the profile signed out — and verify it, because the profile is persistent.** The Playwright
  MCP does **not** use a throwaway profile by default: it keeps one at
  `~/Library/Caches/ms-playwright-mcp/mcp-chrome-*` that survives across sessions (verified
  2026-07-28), so a Google sign-in done once stays. Check for a *Sign in* affordance on the first
  page you read and stop if it's absent. Register the MCP with **`--isolated`** for a genuinely
  fresh profile per run — that flag also lets a second instance start when one already holds the
  shared profile ("Browser is already in use", measured). Never point `--user-data-dir` at the
  user's real Chrome. A signed-in AI Mode answer is personalized and no longer measures the market.
- **Set the market explicitly** rather than trusting the machine's IP: navigate to
  `https://www.google.com/search?q=<urlencoded prompt>&udm=50&hl=<lang>&gl=<country>` (`udm=50` is
  AI Mode). Confirm the AI answer pane actually rendered before reading it — a plain SERP means
  AI Mode did not trigger and the cell must be retried or collected via SerpApi.
- **Wait for the stream to settle, then read once.** Poll `browser_evaluate` every ~1.5s until
  `document.body.innerText` stops growing (cap ~24 samples). Reading mid-stream truncates the answer
  and silently costs you merchants. **There is also an explicit done marker** — the page appends
  `ردّ "وضع AI" أصبح جاهزًا` / *"AI Mode response is ready"* (localized by `hl`) once streaming ends.
  Gate on `ready && length unchanged` and the poll usually exits in one or two samples instead of
  burning all 24.
- **Read the whole body, then trim — do not hunt for an "answer element".** The tempting heuristic
  (*smallest element whose `innerText` > 400 chars*) is **wrong on the current AI Mode DOM**: measured
  2026-07-28, it returns the **citations block**, not the prose, so the cell looks collected but the
  answer is missing. Take `document.body.innerText` and cut both ends instead:
  1. **Start:** `lastIndexOf(QUESTION)` + its length. The question is echoed twice (once in the
     conversation header, once above the answer) — the *last* echo is where the prose begins.
  2. **End:** the citations header, which is **localized and not the word "sites"** — Arabic renders
     `7 مواقع إلكترونية`. Match `/\d+\s*(?:مواقع|sites)/` and slice at `m.index`.
     ⚠ **Never put `\b` after a non-Latin word in a JS regex.** `\b` is defined on `[A-Za-z0-9_]`, so
     `/\d+\s*مواقع\b/` can never match and the citations block silently stays glued to the answer.
     (The same trap bites the backend's own validator — see `DETECTION_UNSUPPORTED_MERCHANT` in
     `RECOVERY.md`.)
  3. Strip bidi control chars (`/[‎‏‪-‮]/g`) before storing, or the raw text
     carries invisible marks that break later substring checks.
  Sanity-check the result: an AI Mode answer under ~80 chars means the trim went wrong or the pane
  never rendered — retry the cell rather than submitting it.
- **Citations:** walk `a[href^="http"]`, drop Google's own chrome (`google.`, `gstatic`,
  `googleusercontent`, plus `support./accounts./policies.google`), dedupe on `hostname + pathname`,
  cap ~12, and keep `hostname + pathname` (not the full URL — long Google redirect query
  strings can read as cookie data and get the whole response blocked).
- **The MCP profile can be locked by another session.** `Browser is already in use for
  …/mcp-chrome-<id>, use --isolated` means a live Chrome already holds that profile — and
  `browser_close` fails with the same error, so you cannot clear it from inside the MCP. It is a
  **user decision, not yours**: that Chrome may belong to their other work. Show them the owning PID
  (`ps aux | grep mcp-chrome-<id>`) and offer the choices — kill it, close it themselves, or take
  SerpApi for `google_ai_mode` instead. Only after they say so: `kill <pid>`, then remove the stale
  `Singleton{Lock,Cookie,Socket}` symlinks in that profile dir before retrying.
- **Do not solve CAPTCHAs or bot checks.** If Google interstitials the fresh profile, wait and
  re-navigate, or fall back to SerpApi for that cell — never hand off to the user's logged-in
  browser to get past it, which would defeat the clean room.
- **No MCP in this session?** `claude mcp add playwright -- npx -y @playwright/mcp@latest`, then the
  session must be **reloaded** before the tools appear. Say that out loud instead of silently
  dropping the route — or use SerpApi, which needs no reload.
