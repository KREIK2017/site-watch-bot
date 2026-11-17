# 🔎 Site Watch Bot

A Telegram bot that watches web pages for you and speaks up the moment something
changes — a price drop, an item back in stock, a site going down, or a page being
edited.

The core runs 24/7 on Cloudflare Workers; the edge runtime and a scheduled
trigger handle the bot and monitoring. An optional small Playwright container
on a VPS handles only sites that reject Cloudflare traffic.

**Status:** live in production · **Worker:** `site-watch-bot.<account>.workers.dev`

---

## Why it exists

Refreshing a product page by hand to catch a discount, or finding out a day late
that your site was returning 500 all night, is work a machine should be doing.
Site Watch Bot checks every five minutes and messages you only when something
actually changed — not on every poll.

Adding a watch is one message: paste a link into the chat. No account, no
dashboard, and no CSS knowledge for the common case.

---

## Features

### 💰 Price tracking
Finds the price with no manual setup on most modern stores, then alerts on
`old → new`. Prices can be displayed in your currency of choice (UAH, USD, EUR,
GBP, PLN) with an approximate conversion appended: `23€ (≈ 1050 грн)`.

### 📦 Stock tracking
Reads in-stock / out-of-stock state from structured data or page text and tells
you the moment an item is available again.

### 🟢 Uptime & status
Reports HTTP status in plain language — *Online*, *Page not found (404)*,
*Server down (5xx)*, *Unreachable* — instead of a raw code. A drop to
"unreachable" is confirmed by two consecutive checks, so a site that
intermittently serves an anti-bot page doesn't spam you. Recovery is always
reported immediately.

### 📝 Content changes
For pages with no price or stock, the bot hashes the visible text and alerts when
it changes. Given a CSS selector it instead tracks one specific value — a manga
chapter number, a forum reply count, a match score — and reports `old → new`.

### 🤖 AI change summary
When a plain content watch fires, the bot asks Claude to compare the previous and
current page text and write one or two sentences on what actually changed,
instead of a vague "the content changed". It is called only *after* a change is
detected, never on every poll, which keeps the cost bounded. Entirely optional:
with no API key configured it silently falls back to the plain message.

### 🌐 Browser fallback
The normal check uses a fast HTTP request. If the response is an anti-bot
challenge, a JavaScript-only shell, or does not contain the requested selector,
the bot retries once through Cloudflare Browser Run and analyzes the rendered
HTML. Browser Run executes JavaScript like Chromium, but still identifies itself
as automated traffic and does not bypass CAPTCHAs or a site's access policy.

Rozetka is a special case: it blocks both direct Workers traffic and Browser
Run. For `rozetka.com.ua` product pages only, the bot makes one final request
through Jina Reader and uses a Rozetka-specific parser to distinguish the old
price from the current discounted price and to read stock labels. The public
Reader endpoint works without configuration; an optional `JINA_API_KEY` raises
its rate limit. No other watched domains are sent to this service.

For stricter sites, the optional [`scraper-service`](./scraper-service) runs a
real Chromium browser on a VPS (for example through Coolify). The Worker calls
it only after the cheaper checks fail. It keeps a separate cookie/localStorage
session for each domain and can use an optional proxy, while an API token and a
domain allowlist prevent it from becoming a public proxy. This improves the
odds for Rozetka/Allegro, but deliberately does not solve CAPTCHAs or promise to
bypass a site's access policy.

Temporary access-provider failures are tracked separately from the website's
real HTTP status. A challenge or Reader timeout never overwrites the last known
title, price, stock, or online status. Scheduled monitoring sends one diagnostic
only after three consecutive failed checks and resets the counter on success.

### 🎮 Steam integration
Steam store links go through the official public API rather than HTML scraping —
exact title, current price, discount. Responses are cached in D1 for four minutes
to stay under Steam's per-IP rate limit.

### 🩺 Site info
For every watch the bot also reports facts about the site itself: response time,
page size, detected CMS or framework (WordPress, Shopify, Next.js, Drupal, Wix,
Squarespace, Webflow), hosting or server (Cloudflare, Vercel, Netlify, nginx,
Apache, LiteSpeed, IIS) and which security headers are present (HSTS, CSP,
X-Frame-Options).

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Cloudflare Workers (edge, TypeScript) |
| Browser fallback | Playwright service on VPS (optional) |
| Database | Cloudflare D1 (SQLite) |
| Scheduling | Cloudflare Cron Trigger (`*/5 * * * *`) |
| Messaging | Telegram Bot API over webhook |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`) |
| External APIs | Steam Store API, open.er-api.com (FX rates) |
| Tests | Vitest |
| CI/CD | GitHub → Cloudflare Workers Builds (auto-deploy on push) |

---

## Architecture

```
                  ┌─────────────────────────┐
   Telegram  ───▶ │ POST /telegram-webhook  │──┐  secret-token header
   (webhook)      └─────────────────────────┘  │  verified before anything
                                               │
   Cron every     ┌─────────────────────────┐  │
   5 minutes ───▶ │ scheduled()             │  │
                  └─────────────────────────┘  │
                               │               │
                               ▼               ▼
                       ┌──────────────────────────┐
                       │       Worker (src/)      │
                       │                          │
                       │  commands.ts  chat UI    │
                       │  monitor.ts   batch run  │
                       │  checker.ts   detection  │
                       │  ai.ts        summaries  │
                       │  currency.ts  FX         │
                       │  history.ts   change log │
                       └──────────────────────────┘
                            │                 │
              ┌─────────────┘                 └───────────────┐
              ▼                                               ▼
      ┌────────────────┐                     ┌────────────────────────────┐
      │  D1 (SQLite)   │                     │  Outbound HTTP             │
      │  watches       │                     │  · watched pages           │
      │  watch_history │                     │  · Steam API   (cached 4m) │
      │  steam_cache   │                     │  · FX rates    (cached 6h) │
      │  fx_cache      │                     │  · Claude API  (on change) │
      │                │                     │  · VPS Chromium (fallback) │
      └────────────────┘                     └────────────────────────────┘
```

Both entry points return immediately and hand the real work to
`ctx.waitUntil()` — Telegram gets its `200 OK` right away and the check runs
after the response is sent. The cron batch runs with a concurrency of 8 and a
15-second timeout per fetch, so one slow site cannot stall the rest.

### How a price is found

A cascade, most trustworthy first:

1. **Steam API** — for `store.steampowered.com/app/...` links.
2. **Structured data** — Schema.org JSON-LD `Product`, then Open Graph
   `product:price:amount`. Works out of the box on Shopify, WooCommerce,
   PrestaShop and similar.
3. **Heuristic** — regex and keywords across the page text. Can be wrong on
   unusual layouts.
4. **Manual CSS selector** — `/watch <url> <selector>`, optionally reading an
   attribute (`<selector> @data-price`) for sites where JavaScript renders the
   final price and the raw HTML only carries `data-*` values.

Every watch records whether its price came from a *trusted* source (1, 2 or 4)
or was a *guess* (3). Only guesses get the **"❔ Wrong price?"** button, which
rescans the page, lists every price-shaped value it found and lets the user pick
the right one by tapping — no CSS knowledge required.

---

## Screenshots

> _Placeholder — real screenshots to be added._

| File | Shows |
| --- | --- |
| `docs/screenshot-watch.png` | Adding a watch by pasting a link |
| `docs/screenshot-alert.png` | A price-change alert |
| `docs/screenshot-list.png` | `/list` with per-watch control cards |
| `docs/screenshot-ai.png` | AI change summary in action |

---

## Bot commands

| Command | What it does |
| --- | --- |
| `/start` · `/status` | Open the live monitoring overview |
| `/sites` | Open the paginated watch list |
| `/add` | Start the guided site/product flow |
| `/alerts` | Recent monitoring events |
| `/settings` | Language and currency settings |
| `/watch <url>` | Legacy quick-add for a whole page |
| `/watch <url> <css-selector>` | Watch one element only |
| `/watch <url> <css-selector> @attr` | Read an attribute instead of the text |
| `/list` | Legacy alias for `/sites` |
| `/check <id>` | Check right now |
| `/history <id>` | Log of recorded price/stock changes (last 15) |
| `/rename <id> <name>` | Rename a watch |
| `/pause <id>` · `/resume <id>` | Suspend / resume checks |
| `/unwatch <id>` | Remove permanently |
| `/currency` | Choose display currency |
| `/help` | Help |

Limit: 20 active watches per chat. Pasting a bare link without `/watch` also
starts a watch.

---

## Deploy from scratch

1. **Install dependencies**

   ```
   npm install
   ```

2. **Log in to Cloudflare** (if you haven't already)

   ```
   npx wrangler login
   ```

3. **Create the D1 database**

   ```
   npm run db:create
   ```

   Copy the returned `database_id` into `wrangler.toml`.

4. **Run the migrations**

   ```
   npm run db:migrate:remote
   ```

5. **Create the bot** through [@BotFather](https://t.me/BotFather) (`/newbot`)
   and keep the token.

6. **Set the worker secrets**

   ```
   npm run secrets:bot-token
   npm run secrets:webhook-secret
   ```

   **Optional** — after deploying `scraper-service` in Coolify, set its HTTPS
   address and the same token you configured as `API_TOKEN` there:

   ```
   npm run secrets:scraper-url
   npm run secrets:scraper-token
   ```

   `WEBHOOK_SECRET` is any random string you invent — a generated UUID is fine.

   **Optional** — for the AI change summary, a key from
   [console.anthropic.com](https://console.anthropic.com):

   ```
   npm run secrets:anthropic-key
   ```

7. **Deploy**

   ```
   npm run deploy
   ```

   Wrangler prints the worker URL, e.g.
   `https://site-watch-bot.<account>.workers.dev`.

8. **Point the Telegram webhook at the worker** — same `WEBHOOK_SECRET` as in
   step 6:

   ```
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d "url=https://site-watch-bot.<account>.workers.dev/telegram-webhook" \
     -d "secret_token=<WEBHOOK_SECRET>"
   ```

9. Send `/start` in Telegram — the bot should reply with help and show the menu.

10. **Optional** — register the command list so Telegram's own menu shows it:

    ```
    curl "https://api.telegram.org/bot<BOT_TOKEN>/setMyCommands" \
      -H "content-type: application/json" \
      -d "{\"commands\":[
        {\"command\":\"start\",\"description\":\"Main menu\"},
        {\"command\":\"watch\",\"description\":\"Watch a site\"},
        {\"command\":\"list\",\"description\":\"My sites\"},
        {\"command\":\"check\",\"description\":\"Check now\"},
        {\"command\":\"unwatch\",\"description\":\"Remove a site\"},
        {\"command\":\"help\",\"description\":\"Help\"}
      ]}"
    ```

After the first deploy a push is enough: GitHub is wired to Cloudflare Workers
Builds, and every push to `master` builds and deploys automatically.

---

## Local development

```
cp .dev.vars.example .dev.vars   # put your token and secret in here
npm run db:migrate:local
npm run dev
```

To exercise the webhook locally, expose `wrangler dev` through a tunnel
(`cloudflared tunnel` or `ngrok`) and point `setWebhook` at that URL temporarily.

## Tests and type checking

```
npm test          # vitest
npm run typecheck
```

Unit tests cover the pure parsing layer — price extraction, stock phrases, status
labels, HTML-to-text, title selection and money parsing. Known limitations are
asserted explicitly rather than left undocumented, so they stay visible instead of
quietly rotting.

---

## Known limitations

- **Anti-bot protection.** Browser Run and the optional VPS Chromium service
  execute JavaScript, but a site can still block a datacenter IP or demand a
  CAPTCHA. A reputable proxy can be configured on the VPS; headers alone are
  not a reliable fix.
- **Whole-page content hashing is deliberately limited.** Once a watch has shown
  a price or stock even once, full-text comparison is disabled for it
  permanently: on commerce pages it is far too noisy (ads, "recently viewed",
  view counters) and it misfires badly on sites that intermittently return a
  challenge page instead of the real one.
- **SSL is checked indirectly.** A TLS failure surfaces as "unreachable";
  certificate expiry is not checked separately.
- **One interval for everyone.** The cron schedule is global; there is no
  per-watch interval.
- **No screenshots of watched pages.** Deliberately deferred — it needs
  Cloudflare Browser Rendering, which is a paid plan.
