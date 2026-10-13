# Claude Gateway — decompress `context.dom_gz` for `/agent`

## Why

The Personalise panel captures the **live, rendered DOM** of the page the SE is
looking at and sends it to `/agent` so the script-writing agent can pick real
selectors. A full-page skeleton is 50–60+ KB — too large for Cloudflare
quick-tunnel transport (which drops requests around 50 KB). Gzip compresses it
~12× (57 KB → ~5 KB gzipped, ~6.5 KB base64), comfortably under the limit.

The panel sends the DOM as `context.dom_gz` (base64-encoded gzip). The gateway
decompresses it into `context.dom` before passing the task + context to the
agent worker, so the agent reads the DOM as plain text.

## Where to patch

In the `/agent` route handler, **after** parsing the request body and
**before** building the prompt / calling the Claude Code worker.

## Express snippet

```js
const zlib = require('zlib');

// Inside the POST /agent handler, after const { task, schema, context } = req.body;
if (context && context.dom_gz && typeof context.dom_gz === 'string') {
  try {
    const gzBuf = Buffer.from(context.dom_gz, 'base64');
    const raw   = zlib.gunzipSync(gzBuf);
    context.dom = raw.toString('utf-8');
    delete context.dom_gz;            // agent only sees the clean text
  } catch (err) {
    console.warn('[agent] dom_gz decompression failed:', err.message);
    // Proceed without DOM — agent can still try; don't fail the whole call.
  }
}
```

That's it — three lines of logic (decode base64 → gunzip → store as string).
`zlib` is a Node built-in; no new dependency.

## How the agent sees it

After decompression, `context.dom` contains the rendered DOM skeleton:

```
section.brand-destinations-tabbed
  h2.brand-destinations-tabbed__title [data-personalise="destinations-title"]  "Where are you waiting to discover?"  {font-family:Merriweather; font-size:33.6px}
  div.destinations-carousel  {display:grid}
    article.destinations-carousel__card
      img [src="/japan.jpg" alt="Japan"]
      h3  "Japan"
    article.destinations-carousel__card
      ...
```

The agent targets `article.destinations-carousel__card` (the real class) rather
than guessing `article.card`. The prompt tells it: "Base every selector on
context.dom — do not guess tag/class names."

## Verify

```bash
# 1. Generate a gzipped base64 blob from a test DOM string:
echo -n '<div class="test">Hello</div>' | gzip | base64

# 2. Send it as context.dom_gz to /agent:
curl -s -X POST http://localhost:4000/agent \
  -H "Content-Type: application/json" -H "x-api-key: <key>" \
  -d '{
    "task": "Read context.dom and return the class name of the first element.",
    "context": { "dom_gz": "<base64 from step 1>" }
  }'
# Expect: agent reads "test" from the decompressed DOM.

# 3. Confirm large payload fits (the panel's Audley page = 57 KB raw → ~6.5 KB base64):
#    A POST with 10 KB body should succeed where 57 KB raw failed.
```

## Security note

`dom_gz` is inert data (a DOM outline, no executable code). The decompression
is synchronous (`gunzipSync`); for very large blobs you could use async
`zlib.gunzip` but the base64 payload is typically 5–15 KB so sync is fine.
The agent's constrained tools (no bash/file) are unaffected — this is just
pre-processing of the context the panel sends.
