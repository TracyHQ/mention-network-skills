// Minimal MCP streamable-HTTP client for the mention-network server. Lets a script call an
// MCP tool with a big `arguments` payload read from disk — instead of the agent inlining the
// whole cells array (tens of KB of answer text) into a tool call by hand, which is slow,
// token-heavy, and easy to mis-escape. Stateless server: no session id, one POST per call.
//
// Endpoint + key come from the env (the same ones the Claude host uses):
//   MENTION_NETWORK_MCP_URL   default https://shopify-mcp-dev.mention.network/api/v1/mcp
//   MENTION_NETWORK_KEY       required (Bearer)
//
// Exports rpc() / callTool() for submit.mjs and any other script; no npm deps (Node ≥18 fetch).

const DEFAULT_URL = 'https://shopify-mcp-dev.mention.network/api/v1/mcp'

// The server answers as SSE (`event: message\ndata: {json}`); collect the data payloads.
export function parseSSE(text) {
  const msgs = []
  for (const line of String(text).split('\n')) {
    const m = line.match(/^data:\s?(.*)$/)
    if (m) {
      try { msgs.push(JSON.parse(m[1])) } catch { /* keep-alive / partial line */ }
    }
  }
  return msgs
}

export async function rpc(method, params, { url, key, fetchImpl = fetch } = {}) {
  const endpoint = url ?? process.env.MENTION_NETWORK_MCP_URL ?? DEFAULT_URL
  const bearer = key ?? process.env.MENTION_NETWORK_KEY
  if (!bearer) throw new Error('missing MENTION_NETWORK_KEY in the environment')
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const ct = res.headers.get?.('content-type') || ''
  const body = await res.text()
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 400)}`)
  const payloads = ct.includes('text/event-stream') ? parseSSE(body) : [safeJson(body)]
  const msg = payloads.find((p) => p && (p.result || p.error)) || payloads[payloads.length - 1]
  if (!msg) throw new Error('MCP: empty response')
  return msg
}

function safeJson(s) {
  try { return JSON.parse(s) } catch { return null }
}

// Call one MCP tool. Returns the tool's structured result: if the tool emits a single text
// content block of JSON (the mention-network convention), it's parsed; otherwise the raw
// content array. Throws on JSON-RPC errors and on `isError` tool results.
export async function callTool(name, args, opts = {}) {
  const out = await rpc('tools/call', { name, arguments: args }, opts)
  if (out.error) throw new Error(`MCP tool ${name} error: ${JSON.stringify(out.error)}`)
  const content = out.result?.content || []
  const textParts = content.filter((c) => c?.type === 'text').map((c) => c.text)
  const parsed = textParts.length === 1 ? safeJson(textParts[0]) : null
  const value = parsed ?? (textParts.length ? textParts.join('\n') : content)
  if (out.result?.isError) {
    throw new Error(`MCP tool ${name} returned isError: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  return value
}
