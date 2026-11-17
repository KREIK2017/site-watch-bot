# VPS scraper service

Small authenticated Playwright service for pages that block Cloudflare Workers
and Browser Run. It uses real Chromium, keeps cookies/localStorage per domain in
`/data/sessions`, and serializes requests to the same host.

It does **not** solve CAPTCHAs or guarantee access. A site may still block a VPS
IP. In that case configure a legitimate proxy with `PROXY_SERVER` or use the
site's official API/feeds where available.

## Coolify

Create an Application from this repository and use:

- Build pack: `Dockerfile`
- Base directory: `/scraper-service`
- Dockerfile location: `/Dockerfile`
- Port: `3000`
- Health check path: `/health`
- Persistent storage: volume mounted at `/data`

Required environment variables:

```text
API_TOKEN=<long random value>
ALLOWED_HOSTS=rozetka.com.ua,allegro.pl
```

Expose it through an HTTPS domain such as `https://scraper.example.com`. Do not
expose `/fetch` without `API_TOKEN`; the service deliberately refuses domains
outside `ALLOWED_HOSTS` so it cannot become a general-purpose proxy.

Then configure the Worker:

```text
npm run secrets:scraper-url
npm run secrets:scraper-token
```

The token entered in Wrangler must exactly match Coolify's `API_TOKEN`.

## Local verification

```text
npm install
npm test
npm run typecheck
```
