# Claude Gateway — `/bootstrap` endpoint (localhost-only, keyless)

## Why

The Personalise panel has a **"Connect to local gateway"** button. It calls, via
Tampermonkey's `GM_xmlhttpRequest` (which bypasses the browser's mixed-content and
CORS rules), `GET http://localhost:4000/bootstrap` and expects:

```json
{ "key": "<a valid gateway key>", "tunnelUrl": "https://<current-tunnel-host>" }
```

The panel then stores those and makes all `/complete` calls over the **HTTPS
tunnel** with the key — so the SE never copy-pastes a URL or key.

## Security model (important)

`/bootstrap` returns a real key with **no auth**, so it MUST be reachable **only
from localhost** and MUST NOT be exposed over the public tunnel. Enforce a
localhost bind-check *before* any response, and make the tunnel path 404 it.

## Express snippet

Register this BEFORE the API-key middleware (so the key check doesn't block it),
and gate it on the connection being local.

```js
const os = require('os');

function isLocalRequest(req) {
  // Trust the socket's remote address, not headers (which a proxy can spoof).
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

app.get('/bootstrap', (req, res) => {
  if (!isLocalRequest(req)) {
    // Over the tunnel this is a non-local request → behave as if it doesn't exist.
    return res.status(404).json({ error: 'not found' });
  }
  // No key required here — the request is provably from this machine.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.json({
    key: CURRENT_GATEWAY_KEY,       // the key you'd otherwise paste from the dashboard
    tunnelUrl: CURRENT_TUNNEL_URL,  // the public https URL the gateway is tunnelled on
  });
});
```

### Sourcing the two values
- `CURRENT_GATEWAY_KEY` — the gateway already has/issues keys; return a valid one
  (ideally a dedicated "demo" key you can rotate).
- `CURRENT_TUNNEL_URL` — the gateway starts the Cloudflare tunnel, so it knows the
  public URL. Capture it when you launch `cloudflared` (parse its stdout for the
  `https://<name>.trycloudflare.com` line, or use a **named** tunnel so the URL is
  fixed and can be a constant/env var).

## Verify

```bash
# From the gateway machine — should return the JSON:
curl -s http://localhost:4000/bootstrap

# Over the tunnel — MUST be 404 (never expose the key publicly):
curl -s -o /dev/null -w "%{http_code}\n" https://<tunnel-host>/bootstrap   # expect 404
```

Once both hold, the panel's **Connect to local gateway** button works end-to-end
from any customer HTTPS site (through the Tampermonkey userscript).

## Note on the CORS/preflight

`GM_xmlhttpRequest` does NOT send a browser preflight (it's not a page fetch), so
`/bootstrap` doesn't need the `OPTIONS` handling that `gateway-cors-patch.md` adds
for `/complete`. The `Access-Control-Allow-Origin` line above is belt-and-braces.
