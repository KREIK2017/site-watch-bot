import type { AnalyzeResult, Env } from "./types";

const OUT_OF_STOCK_PATTERNS = [
  "out of stock",
  "sold out",
  "unavailable",
  "currently unavailable",
  "notify me when available",
  "немає в наявності",
  "нема в наявності",
  "нет в наличии",
  "закінчився",
];

const IN_STOCK_PATTERNS = [
  "in stock",
  "add to cart",
  "add to basket",
  "buy now",
  "в наявності",
  "додати в кошик",
  "в наличии",
];

// One dollar/euro/pound/hryvnia sign (or 3-letter code) glued to a number, in
// either order. Keep this code list in sync with currency.ts's KNOWN_CODES —
// a price extracted here but unrecognized there can't be converted.
const PRICE_RE =
  /(?:[$€£₴¥]\s?\d[\d\s.,]{0,12}\d|\d[\d\s.,]{0,12}\d\s?(?:USD|EUR|UAH|GBP|PLN|BGN|CZK|CHF|CAD|AUD|JPY|\$|€|£|₴))/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutNoise.replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function extractTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const decoded = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return decoded || null;
}

export function extractPrice(text: string): string | null {
  const match = text.match(PRICE_RE);
  if (match) return match[0].replace(/\s+/g, " ").trim();
  // A selector (especially one targeting a data-* attribute) can return a bare
  // number with no currency sign at all, e.g. data-price="501.50" — still a price.
  const trimmed = text.trim();
  if (/^\d[\d\s.,]{0,12}\d$|^\d$/.test(trimmed)) return trimmed;
  return null;
}

export function extractStock(text: string): string | null {
  const lower = text.toLowerCase();
  if (OUT_OF_STOCK_PATTERNS.some((p) => lower.includes(p))) return "Немає в наявності";
  if (IN_STOCK_PATTERNS.some((p) => lower.includes(p))) return "В наявності";
  return null;
}

const AVAILABILITY_MAP: Record<string, string> = {
  instock: "В наявності",
  limitedavailability: "Обмежена кількість",
  outofstock: "Немає в наявності",
  soldout: "Немає в наявності",
  discontinued: "Знято з продажу",
  preorder: "Передзамовлення",
};

function mapAvailability(raw: string): string | null {
  const key = raw.split("/").pop()?.toLowerCase().replace(/[^a-z]/g, "");
  return key ? AVAILABILITY_MAP[key] ?? null : null;
}

// A bare number ("36.32") is ambiguous without a currency; attach one only
// when the value doesn't already carry a symbol/code of its own.
function withCurrency(price: string, currency: string | null | undefined): string {
  if (!currency || /[a-zA-Z₴$€£¥]/.test(price)) return price;
  return `${price} ${currency.trim().toUpperCase()}`;
}

// Finds a Product node in a JSON-LD document, which may be a single object,
// an array of objects, or wrapped in a top-level "@graph" array — all three
// shapes are common across e-commerce platforms.
function findProductNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductNode(item);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("Product")) return obj;
  if (obj["@graph"]) return findProductNode(obj["@graph"]);
  return null;
}

// Most modern storefronts (Shopify, WooCommerce, PrestaShop, Wix...) embed the
// name/price/availability as static Schema.org JSON-LD or Open Graph meta tags
// — meant for Google, but it means this often exists in the raw HTML even on
// sites where the *visible* price is drawn in later by JavaScript. Checking
// this first lets most /watch calls skip the CSS-selector step entirely.
function extractStructuredData(html: string): { title: string | null; price: string | null; stock: string | null } {
  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const scriptMatch of scripts) {
    try {
      const product = findProductNode(JSON.parse(scriptMatch[1].trim()));
      if (!product) continue;

      const title = typeof product.name === "string" ? product.name.trim() : null;

      const offersRaw = product.offers;
      const offer = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw;
      let price: string | null = null;
      let stock: string | null = null;
      if (offer && typeof offer === "object") {
        const o = offer as Record<string, unknown>;
        const rawPrice = o.price !== undefined && o.price !== null ? String(o.price).trim() : null;
        const currency = typeof o.priceCurrency === "string" ? o.priceCurrency : null;
        price = rawPrice ? withCurrency(rawPrice, currency) : null;
        stock = typeof o.availability === "string" ? mapAvailability(o.availability) : null;
      }

      if (title || price || stock) return { title, price, stock };
    } catch {
      // Malformed JSON-LD is common in the wild; just skip that block.
    }
  }

  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const metaPrice = html.match(
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|price)["'][^>]+content=["']([^"']+)["']/i
  );
  const metaCurrency = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["']/i);
  return {
    title: ogTitle ? decodeEntities(ogTitle[1]).trim() : null,
    price: metaPrice ? withCurrency(metaPrice[1].trim(), metaCurrency?.[1] ?? null) : null,
    stock: null,
  };
}

// Some large sites (Amazon: <meta property="og:title" content="Amazon"/>) set
// a deliberately generic og:title for social-share cards while the real,
// specific product name only lives in <title> — prefer whichever is longer
// rather than trusting og:title/JSON-LD unconditionally.
export function pickTitle(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function extractTitle(html: string): string | null {
  const raw = pickTitle(extractStructuredData(html).title, extractTitleTag(html));
  return raw ? truncate(raw, 120) : null;
}

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// HTTP status codes mean nothing to a non-technical user, so every place that
// shows a status shows this instead of the raw number.
export function humanizeStatus(status: number | null): string {
  if (status === null) return "🔴 Недоступний";
  if (status >= 200 && status < 300) return "🟢 Онлайн";
  if (status >= 300 && status < 400) return "🟡 Перенаправлення";
  if (status === 404) return "🔴 Сторінку не знайдено (404)";
  if (status === 403) return "🔴 Доступ заборонено (403)";
  if (status >= 400 && status < 500) return `🔴 Помилка сторінки (${status})`;
  if (status >= 500) return `🔴 Сервер лежить (${status})`;
  return `Статус ${status}`;
}

// "<css-selector> @attr-name" reads one attribute instead of the element's text.
// Needed for sites that fill in the real price via JS and only ship the raw
// number as a data-* attribute (e.g. data-special-price="501.50") in the HTML
// the bot actually receives.
function parseSelectorSpec(spec: string): { selector: string; attr: string | null } {
  const match = spec.match(/^(.*)\s@([a-zA-Z_:][-a-zA-Z0-9_:.]*)$/);
  if (match) return { selector: match[1].trim(), attr: match[2] };
  return { selector: spec.trim(), attr: null };
}

// Scopes extraction to one element via Cloudflare's native streaming HTML
// parser, so /watch on a product page tracks that product instead of
// whichever price/availability text happens to appear first on the page.
async function extractBySelector(response: Response, spec: string): Promise<string> {
  const { selector, attr } = parseSelectorSpec(spec);
  let captured = "";
  const rewriter = new HTMLRewriter().on(
    selector,
    attr
      ? {
          element(el) {
            if (!captured) captured = el.getAttribute(attr) ?? "";
          },
        }
      : {
          text(chunk) {
            captured += chunk.text;
          },
        }
  );
  await rewriter.transform(response).text();
  return captured.replace(/\s+/g, " ").trim();
}

// Fixed rules used to hunt for price-shaped values without the user ever
// writing CSS themselves. Short ids so they fit in a Telegram callback_data
// (max 64 bytes) as "auto:<id>:<occurrence index>".
const CANDIDATE_RULES: { id: string; selector: string; attr: string | null }[] = [
  { id: "sp", selector: "[data-special-price]", attr: "data-special-price" },
  { id: "dp", selector: "[data-price]", attr: "data-price" },
  { id: "dv", selector: "[data-value]", attr: "data-value" },
  { id: "ip", selector: '[itemprop="price"]', attr: null },
  { id: "cp", selector: '[class*="price"]', attr: null },
];

function isPriceLike(value: string): boolean {
  return PRICE_RE.test(value) || /^\d[\d\s.,]{0,12}\d$|^\d$/.test(value.trim());
}

// Collects every match for one rule, in document order, one entry per
// matched element (not per text chunk) — needed so "auto:cp:2" reliably
// means "the 3rd .price-ish element" on later checks.
async function scanRuleMatches(response: Response, selector: string, attr: string | null): Promise<string[]> {
  const values: string[] = [];
  let current = -1;
  const rewriter = new HTMLRewriter().on(
    selector,
    attr
      ? {
          element(el) {
            values.push(el.getAttribute(attr) ?? "");
          },
        }
      : {
          element() {
            values.push("");
            current = values.length - 1;
          },
          text(chunk) {
            if (current >= 0) values[current] += chunk.text;
          },
        }
  );
  await rewriter.transform(response).text();
  return values.map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean);
}

async function extractByAutoSpec(response: Response, spec: string): Promise<string> {
  const [, ruleId, indexRaw] = spec.split(":");
  const rule = CANDIDATE_RULES.find((r) => r.id === ruleId);
  const index = Number(indexRaw);
  if (!rule || !Number.isInteger(index)) return "";
  const values = await scanRuleMatches(response, rule.selector, rule.attr);
  return values[index] ?? "";
}

export interface PriceCandidate {
  ruleId: string;
  index: number;
  value: string;
}

// Powers the "❔ Wrong price?" button: re-fetches the page and surfaces every
// plausible price-shaped value found on it, deduped, so the user can just tap
// the correct one instead of ever writing a CSS selector.
export async function findPriceCandidates(response: Response): Promise<PriceCandidate[]> {
  const found: PriceCandidate[] = [];
  const seen = new Set<string>();

  for (const rule of CANDIDATE_RULES) {
    let values: string[];
    try {
      values = await scanRuleMatches(response.clone(), rule.selector, rule.attr);
    } catch {
      continue;
    }
    values.forEach((value, index) => {
      if (!isPriceLike(value)) return;
      const key = value.replace(/\s+/g, "");
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ ruleId: rule.id, index, value });
    });
    if (found.length >= 6) break;
  }

  return found.slice(0, 6);
}

export const BOT_USER_AGENT = "Mozilla/5.0 (compatible; SiteWatchBot/1.0)";

const FETCH_TIMEOUT_MS = 15000;

// A hung/very slow site would otherwise tie up its whole cron batch until
// Cloudflare's own subrequest ceiling kicks in — bound it explicitly instead.
export async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const STEAM_APP_RE = /store\.steampowered\.com\/app\/(\d+)/i;

interface SteamPriceOverview {
  currency: string;
  final_formatted: string;
  discount_percent: number;
}

interface SteamAppData {
  name?: string;
  is_free?: boolean;
  price_overview?: SteamPriceOverview;
  release_date?: { coming_soon?: boolean };
}

const STEAM_CACHE_MS = 4 * 60 * 1000; // just under the 5 min cron cadence

// Steam's public appdetails API has an undocumented, fairly aggressive per-IP
// rate limit that a handful of near-simultaneous checks can trip. Caching the
// raw response in D1 means a manual "🔄 Перевірити" tap right after cron (or
// several watches on the same game) reuse one fetch instead of hammering it.
async function fetchSteamData(env: Env, appId: string): Promise<SteamAppData | null> {
  const cached = await env.DB.prepare("SELECT data, fetched_at FROM steam_cache WHERE app_id = ?")
    .bind(appId)
    .first<{ data: string; fetched_at: string }>();
  if (cached && Date.now() - new Date(`${cached.fetched_at}Z`).getTime() < STEAM_CACHE_MS) {
    return JSON.parse(cached.data) as SteamAppData;
  }

  try {
    const res = await fetchWithTimeout(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=ua&l=ukrainian`,
      { headers: { "user-agent": BOT_USER_AGENT } }
    );
    if (!res.ok) return cached ? (JSON.parse(cached.data) as SteamAppData) : null;
    const json = (await res.json()) as Record<string, { success: boolean; data?: SteamAppData }>;
    const entry = json[appId];
    if (!entry?.success || !entry.data) return cached ? (JSON.parse(cached.data) as SteamAppData) : null;

    await env.DB.prepare(
      `INSERT INTO steam_cache (app_id, data, fetched_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(app_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`
    )
      .bind(appId, JSON.stringify(entry.data))
      .run();
    return entry.data;
  } catch {
    return cached ? (JSON.parse(cached.data) as SteamAppData) : null;
  }
}

async function analyzeSteam(env: Env, appId: string): Promise<AnalyzeResult | null> {
  try {
    const data = await fetchSteamData(env, appId);
    if (!data) return null;
    const title = data.name ? truncate(data.name, 120) : null;
    let price: string | null = null;
    let stock: string | null = null;

    if (data.is_free) {
      price = "Безкоштовно";
      stock = "В наявності";
    } else if (data.price_overview) {
      const po = data.price_overview;
      price = po.discount_percent > 0 ? `${po.final_formatted} (-${po.discount_percent}%)` : po.final_formatted;
      stock = "В наявності";
    } else if (data.release_date?.coming_soon) {
      stock = "Ще не вийшла (передпродаж/анонс)";
    }

    return {
      status: 200,
      sslOk: true,
      title,
      textHash: await sha256(JSON.stringify({ price: data.price_overview, isFree: data.is_free })),
      value: null,
      content: null,
      price,
      priceTrusted: true,
      stock,
    };
  } catch {
    return null;
  }
}

export async function analyzeUrl(env: Env, url: string, selector?: string | null): Promise<AnalyzeResult> {
  const steamMatch = url.match(STEAM_APP_RE);
  if (steamMatch) {
    const steamResult = await analyzeSteam(env, steamMatch[1]);
    if (steamResult) return steamResult;
    // Steam's appdetails API occasionally rate-limits/blocks. Report it as a
    // transient error instead of falling through to scraping the store page's
    // HTML, which would misreport a real product as "changed" or "403".
    return {
      status: null,
      sslOk: true,
      title: null,
      textHash: null,
      value: null,
      content: null,
      price: null,
      priceTrusted: false,
      stock: null,
      error: "Steam API тимчасово недоступний, спробую при наступній перевірці",
    };
  }

  try {
    const res = await fetchWithTimeout(url, {
      redirect: "follow",
      headers: { "user-agent": BOT_USER_AGENT },
    });
    const status = res.status;
    // A non-2xx response body is almost always an error/bot-challenge page
    // ("Just a moment...", "Access denied"...), never the real page title.
    const ok = status >= 200 && status < 300;

    if (selector) {
      const title = ok ? extractTitle(await res.clone().text().catch(() => "")) : null;
      const text = selector.startsWith("auto:")
        ? await extractByAutoSpec(res, selector)
        : await extractBySelector(res, selector);
      if (!text) {
        return {
          status,
          sslOk: true,
          title,
          textHash: null,
          value: null,
          content: null,
          price: null,
          priceTrusted: false,
          stock: null,
          error: `Селектор "${selector}" нічого не знайшов на сторінці`,
        };
      }
      return {
        status,
        sslOk: true,
        title,
        textHash: await sha256(text),
        // The raw scoped text, kept alongside price/stock so non-commerce
        // watches (a manga chapter list, a forum reply count, a score) can
        // still show and diff a meaningful "was X, now Y" instead of just
        // "content changed" when it isn't shaped like a price at all.
        value: text,
        content: null,
        price: extractPrice(text),
        priceTrusted: true,
        stock: extractStock(text),
      };
    }

    const html = await res.text();
    const text = htmlToText(html);
    const structured = ok ? extractStructuredData(html) : { title: null, price: null, stock: null };
    const title = ok ? pickTitle(structured.title, extractTitleTag(html)) : null;
    return {
      status,
      sslOk: true,
      title: title ? truncate(title, 120) : null,
      // A non-2xx body (a Cloudflare/anti-bot challenge page, a WAF block
      // page...) isn't real content — hashing it would compare "real page"
      // against "challenge page" on the next flip and misreport that as the
      // page having changed, even though nothing actually did.
      textHash: ok ? await sha256(text) : null,
      value: null,
      // Feeds the AI change-summary feature (only meaningful for watches
      // that never show a price/stock — see the isCommercePage gate in
      // monitor.ts). Capped well short of a prompt-worrying size.
      content: ok ? truncate(text, 4000) : null,
      price: ok ? structured.price ?? extractPrice(text) : null,
      priceTrusted: Boolean(structured.price),
      stock: ok ? structured.stock ?? extractStock(text) : null,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const sslOk = !/ssl|certificate|tls/i.test(rawMessage);
    // A redirect-loop error dumps the entire chain of URLs it followed into
    // the message, which is both unreadable and can badly overflow a
    // Telegram message; a fetch failure can in general say anything, so cap
    // every message defensively rather than trusting it to stay short.
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Сайт не відповів за 15 секунд (тайм-аут)"
        : /too many redirect/i.test(rawMessage)
          ? "Забагато перенаправлень — сайт зациклився на редиректах"
          : truncate(rawMessage, 200);
    return {
      status: null,
      sslOk,
      title: null,
      textHash: null,
      value: null,
      content: null,
      price: null,
      priceTrusted: false,
      stock: null,
      error: message,
    };
  }
}
