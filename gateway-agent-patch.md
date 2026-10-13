# Claude Gateway — `POST /agent` (general tool-using harness)

## Why

`/complete` is one text turn. Some personalisation tasks are agentic loops with
tools — e.g. "generate recommendation cards, then check every image URL actually
resolves and find public replacements for broken ones." That needs real HTTP +
image search, which a browser can't do. The gateway already wraps the Claude
Code CLI (an agent with tools); `/agent` exposes that loop so the panel can hand
off a task and get back a verified result.

The Personalise panel calls this from the recStrip editor ("Verify & fix images
(agent)") and via a generic `gatewayAgent(task, schema, context)` client helper.

## Contract

```
POST /agent
headers: { "Content-Type": "application/json", "x-api-key": "<gateway key>" }
body:    {
  "task":    "<natural-language task>",
  "schema":  <optional JSON shape the final answer must match>,
  "context": <optional object, e.g. { intent, cards }>
}
resp:    {
  "result": <JSON matching schema>,   // preferred
  "text":   "<raw final text>",       // fallback if no structured result
  "steps":  <optional array of what the agent did>
}
```
Non-2xx on failure. The client treats **404** as "endpoint not implemented yet".

## Behaviour

- **Key-gated** exactly like `/complete` (same `x-api-key`). Do NOT expose
  unauthenticated, and do NOT serve it over a bare public tunnel path without the
  key check — this runs an agent.
- Run the Claude Code worker as an agent on `task` (+ `context`), looping with
  tools until done, then return the final answer (coerced to `schema` if given).

## Security — CONSTRAIN THE TOOLS (important)

An arbitrary `task` + full Claude Code tools = remote code execution via the
gateway. Restrict the worker to a **read-only research/verify tool set**:

- Allow: HTTP GET/HEAD a URL (to check an image resolves + its content-type),
  web/image search.
- Deny: bash/shell, file write, arbitrary file read, any mutation.

Run the worker with an explicit allowlist, e.g. (illustrative):
```
claude -p "<task + context>" \
  --allowedTools "WebSearch,WebFetch" \
  --disallowedTools "Bash,Write,Edit" \
  --output-format json
```
(Map to whatever your gateway's CLI invocation supports.) Also set a **hard cap**
on iterations / wall-clock (the client aborts at 180s) so a task can't run away.

## Example (image verification)

Request `task` (abridged): "For each card, check the image URL resolves (HTTP 200,
image content-type); if missing/broken, find a public hotlink-safe image matching
the card's text and replace the url; keep text unchanged; return the full cards
array." `context`: `{ intent, cards:[{image,lines}] }`. `schema`:
`{ cards:[{ image:"string(url)", lines:["string"] }] }`.

Response: `{ "result": { "cards": [ { "image": "<verified url>", "lines": [...] }, … ] } }`.

## Verify

```bash
curl -s -X POST http://localhost:4000/agent \
  -H "Content-Type: application/json" -H "x-api-key: <key>" \
  -d '{"task":"return {\"ok\":true} as JSON","schema":{"ok":"bool"}}'
# expect: {"result":{"ok":true}, ...}
```

Once `/agent` is live, the panel's "Verify & fix images (agent)" button returns
cards with every image validated/replaced.
