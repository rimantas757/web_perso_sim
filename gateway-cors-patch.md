# Claude Gateway — CORS patch (Express)

## Why
The gateway runs fine server-to-server (curl works), but **browser calls from a
web page are blocked**. Two problems, confirmed by probing the tunnel:

1. The CORS **preflight** `OPTIONS /complete` returns **401** — the API-key
   middleware runs before anything else and rejects it. Browsers send the
   preflight *without* custom headers (no `x-api-key`), so it can never pass.
   A preflight must return `204`, never `401`.
2. **No `Access-Control-Allow-*` headers** on any response, so even a simple
   cross-origin `GET /health` is blocked.

Server is Node/Express (`x-powered-by: Express`). Fix is two small changes.

## The fix

Add a CORS middleware **before** the auth middleware, and make the auth
middleware **skip `OPTIONS`**. Order matters — CORS/preflight handling must come
first in the stack.

```js
// --- CORS: must be registered BEFORE the API-key auth middleware ---
app.use((req, res, next) => {
  // Reflect the caller's origin so the engine works from any prospect site.
  // (If you prefer an allowlist, replace with a check against known origins.)
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.setHeader('Access-Control-Max-Age', '86400'); // cache preflight 24h
  // Short-circuit the preflight BEFORE auth can 401 it.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Auth middleware: skip OPTIONS so preflights are never rejected ---
function requireKey(req, res, next) {
  if (req.method === 'OPTIONS') return next();      // <-- add this line
  const key = req.get('x-api-key')
    || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || !isValidKey(key)) {
    return res.status(401).json({ error: 'unauthorized — provide a valid API key' });
  }
  next();
}
```

If the gateway uses the `cors` npm package instead of a hand-rolled middleware,
the equivalent is:

```js
const cors = require('cors');
app.use(cors({
  origin: true,                 // reflect request origin
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  maxAge: 86400,
}));
// cors() answers OPTIONS automatically — but still ensure the key check
// runs AFTER app.use(cors(...)) and skips OPTIONS as above.
```

## Verify after patching

```bash
# Preflight should now be 204 with Allow-Origin echoing the Origin:
curl -i -X OPTIONS https://<tunnel>/complete \
  -H "Origin: https://www.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: x-api-key,content-type"
# Expect: HTTP/1.1 204, Access-Control-Allow-Origin: https://www.example.com

# Health should carry the CORS header too:
curl -i https://<tunnel>/health -H "Origin: https://www.example.com" | grep -i access-control
# Expect: Access-Control-Allow-Origin: https://www.example.com
```

Once the preflight returns 204 with an `Access-Control-Allow-Origin` header, the
Personalise panel's **Test** and **Generate with gateway** buttons will connect
from any site.
```
