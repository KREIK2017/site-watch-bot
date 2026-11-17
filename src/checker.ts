import { STOCK_DISCONTINUED, STOCK_IN, STOCK_LIMITED, STOCK_OUT, STOCK_PREORDER } from "./i18n";
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

const LIMITED_STOCK_PATTERNS = ["low stock", "закінчується", "осталось мало"];

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

// Returns a language-agnostic internal code (STOCK_IN/STOCK_OUT), not display
// text — localizeStock() in i18n.ts renders it in the chat's language.
export function extractStock(text: string): string | null {
  const lower = text.toLowerCase();
  if (OUT_OF_STOCK_PATTERNS.some((p) => lower.includes(p))) return STOCK_OUT;
  if (LIMITED_STOCK_PATTERNS.some((p) => lower.includes(p))) return STOCK_LIMITED;
  if (IN_STOCK_PATTERNS.some((p) => lower.includes(p))) return STOCK_IN;
  return null;
}

const AVAILABILITY_MAP: Record<string, string> = {
  instock: STOCK_IN,
  limitedavailability: "limited",
  outofstock: STOCK_OUT,
  soldout: STOCK_OUT,
  discontinued: STOCK_DISCONTINUED,
  preorder: STOCK_PREORDER,
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

function entityName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const entity = value as Record<string, unknown>;
  for (const key of ["name", "alternateName", "legalName", "login"]) {
    if (typeof entity[key] === "string" && entity[key].trim()) return entity[key].trim();
  }
  return null;
}

function extractAllegroSellerFromMarkup(html: string): string | null {
  // Allegro seller profiles use a stable public URL even though CSS classes
  // are generated and change frequently. Prefer that URL over visual classes.
  const profile = html.match(/href=["'][^"']*\/uzytkownik\/([^"'/?#<]+)[^"']*["']/i);
  if (profile) {
    try {
      return decodeURIComponent(decodeEntities(profile[1])).trim() || null;
    } catch {
      return decodeEntities(profile[1]).trim() || null;
    }
  }

  // Some rendered variants keep the selected offer only in application JSON.
  const embedded = html.match(/"seller"\s*:\s*\{[\s\S]{0,1200}?"(?:login|name)"\s*:\s*"([^"\\]+)"/i);
  return embedded ? decodeEntities(embedded[1]).trim() || null : null;
}

// Most modern storefronts (Shopify, WooCommerce, PrestaShop, Wix...) embed the
// name/price/availability as static Schema.org JSON-LD or Open Graph meta tags
// — meant for Google, but it means this often exists in the raw HTML even on
// sites where the *visible* price is drawn in later by JavaScript. Checking
// this first lets most /watch calls skip the CSS-selector step entirely.
export function extractStructuredData(html: string): {
  title: string | null;
  price: string | null;
  stock: string | null;
  seller: string | null;
} {
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
      let seller: string | null = null;
      if (offer && typeof offer === "object") {
        const o = offer as Record<string, unknown>;
        const rawPrice = o.price !== undefined && o.price !== null ? String(o.price).trim() : null;
        const currency = typeof o.priceCurrency === "string" ? o.priceCurrency : null;
        price = rawPrice ? withCurrency(rawPrice, currency) : null;
        stock = typeof o.availability === "string" ? mapAvailability(o.availability) : null;
        seller = entityName(o.seller) ?? entityName(o.offeredBy);
      }
      seller ??= entityName(product.seller) ?? extractAllegroSellerFromMarkup(html);

      if (title || price || stock || seller) return { title, price, stock, seller };
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
    seller: extractAllegroSellerFromMarkup(html),
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

// Best-effort CMS/framework fingerprinting for the "site info" block shown on
// plain (non-commerce) watches — a generator meta tag when the site bothers
// to keep one, else a handful of well-known asset-path/script signatures.
const PLATFORM_SIGNATURES: { pattern: RegExp; name: string }[] = [
  { pattern: /wp-content|wp-includes|wp-json/i, name: "WordPress" },
  { pattern: /cdn\.shopify\.com|Shopify\.theme/i, name: "Shopify" },
  { pattern: /static\.wixstatic\.com/i, name: "Wix" },
  { pattern: /static1\.squarespace\.com/i, name: "Squarespace" },
  { pattern: /__NEXT_DATA__/i, name: "Next.js" },
  { pattern: /assets-global\.website-files\.com/i, name: "Webflow" },
  { pattern: /Drupal\.settings|\/sites\/default\/files/i, name: "Drupal" },
];

export function detectPlatform(html: string): string | null {
  const generatorMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (generatorMatch) {
    const known = ["WordPress", "Joomla", "Drupal", "Wix", "Shopify", "Squarespace", "Webflow", "Ghost"];
    const found = known.find((k) => generatorMatch[1].toLowerCase().includes(k.toLowerCase()));
    if (found) return found;
  }
  return PLATFORM_SIGNATURES.find((sig) => sig.pattern.test(html))?.name ?? null;
}

export function detectHosting(headers: Headers): string | null {
  const server = (headers.get("server") ?? "").toLowerCase();
  if (server.includes("cloudflare")) return "Cloudflare";
  if (server.includes("netlify")) return "Netlify";
  if (headers.get("x-vercel-id") !== null) return "Vercel";
  if (server.includes("github.com")) return "GitHub Pages";
  if (server.includes("nginx")) return "nginx";
  if (server.includes("apache")) return "Apache";
  if (server.includes("litespeed")) return "LiteSpeed";
  if (server.includes("microsoft-iis")) return "IIS";
  return null;
}

export function detectSecurityHeaders(headers: Headers): string | null {
  const found: string[] = [];
  if (headers.get("strict-transport-security")) found.push("HSTS");
  if (headers.get("content-security-policy")) found.push("CSP");
  if (headers.get("x-frame-options")) found.push("X-Frame-Options");
  return found.length ? found.join(", ") : null;
}

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
const BROWSER_TIMEOUT_MS = 25000;

interface LoadedPage {
  status: number;
  headers: Headers;
  html: string;
  responseMs: number;
  source: "direct" | "browser" | "vps" | "reader";
}

interface BrowserContentResult {
  success: true;
  result: string;
  meta: {
    status: number;
    title: string;
    headers?: Record<string, string>;
    finalUrl?: string;
  };
}

interface ReaderResult {
  data?: {
    title?: string;
    content?: string;
  };
}

interface ScraperServiceResult {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  html?: string;
  responseMs?: number;
  blocked?: boolean;
  blockReason?: string | null;
  error?: string;
}

const READER_FALLBACK_HOSTS = new Set(["rozetka.com.ua", "www.rozetka.com.ua"]);

function escapeAsHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function supportsReaderFallback(url: string): boolean {
  try {
    return READER_FALLBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function extractRozetkaData(text: string): { price: string | null; stock: string | null } {
  // Product pages put the old and current prices between the product heading/
  // code and the first Buy button. The current price is the last price in that
  // block; later prices belong to delivery, instalments and extra services.
  const codeIndex = text.search(/Код\s*:\s*\d+/i);
  const start = codeIndex >= 0 ? codeIndex : 0;
  const buyOffset = text.slice(start).search(/Купити/i);
  const end = buyOffset >= 0 ? start + buyOffset : Math.min(text.length, start + 3000);
  const productBlock = text.slice(start, end);
  const stockBlock = text.slice(Math.max(0, start - 1000), end);
  const priceRe = new RegExp(PRICE_RE.source, "gi");
  const prices = [...productBlock.matchAll(priceRe)].map((match) => match[0].replace(/\s+/g, " ").trim());
  return {
    price: prices.length ? prices[prices.length - 1] : null,
    stock: extractStock(stockBlock),
  };
}

// Challenge pages can return HTTP 200, so status alone is insufficient.
export function detectChallenge(status: number, headers: Headers, html: string): string | null {
  if (headers.get("cf-mitigated")?.toLowerCase() === "challenge") return "Cloudflare challenge";

  const sample = html.slice(0, 120_000).toLowerCase();
  if (
    sample.includes("/cdn-cgi/challenge-platform/") ||
    sample.includes("cf_chl_opt") ||
    /<title[^>]*>\s*(just a moment|attention required|access denied)/i.test(sample) ||
    sample.includes("checking your browser before accessing") ||
    sample.includes("verify you are human") ||
    sample.includes("please enable js and disable any ad blocker")
  ) {
    return "anti-bot challenge";
  }

  if (status === 429) return "rate limited";
  if (status === 403) return "access forbidden";
  if (status === 503 && sample.includes("captcha")) return "CAPTCHA challenge";
  return null;
}

function looksLikeJavaScriptShell(html: string, text: string): boolean {
  if (text.length >= 160) return false;
  return (
    /<div[^>]+id=["'](?:root|app|__next)["'][^>]*>\s*<\/div>/i.test(html) ||
    /\b(?:__NEXT_DATA__|webpackJsonp|window\.__NUXT__)\b/i.test(html)
  );
}

async function loadDirectPage(url: string): Promise<LoadedPage> {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: {
      "user-agent": BOT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "uk-UA,uk;q=0.9,en;q=0.7",
    },
  });
  return {
    status: response.status,
    headers: response.headers,
    html: await response.text(),
    responseMs: Date.now() - startedAt,
    source: "direct",
  };
}

async function loadRenderedPage(env: Env, url: string): Promise<LoadedPage | null> {
  if (!env.BROWSER) return null;
  const startedAt = Date.now();
  try {
    const response = await env.BROWSER.quickAction("content", {
      url,
      gotoOptions: { waitUntil: "networkidle2", timeout: BROWSER_TIMEOUT_MS },
      actionTimeout: BROWSER_TIMEOUT_MS,
      waitForTimeout: 1000,
      bestAttempt: true,
      cacheTTL: 60,
      rejectResourceTypes: ["image", "media", "font"],
    });
    if (!response.ok) {
      console.warn("Browser Run failed", response.status, await response.text().catch(() => ""));
      return null;
    }
    const payload = (await response.json()) as BrowserContentResult;
    if (!payload.success || typeof payload.result !== "string") return null;
    return {
      status: payload.meta.status,
      headers: new Headers(payload.meta.headers ?? {}),
      html: payload.result,
      responseMs: Date.now() - startedAt,
      source: "browser",
    };
  } catch (err) {
    console.warn("Browser Run fallback failed", err);
    return null;
  }
}

async function loadVpsPage(env: Env, url: string, selector?: string | null): Promise<LoadedPage | null> {
  const baseUrl = env.SCRAPER_SERVICE_URL?.trim();
  const token = env.SCRAPER_SERVICE_TOKEN?.trim();
  if (!baseUrl || !token) return null;

  const startedAt = Date.now();
  try {
    const endpoint = new URL("/fetch", baseUrl);
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
      console.warn("Refusing non-HTTPS scraper service URL");
      return null;
    }
    const response = await fetchWithTimeout(
      endpoint.toString(),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ url, selector: selector ?? undefined }),
      },
      45000
    );
    if (!response.ok) {
      console.warn("VPS scraper failed", response.status, await response.text().catch(() => ""));
      return null;
    }
    const payload = (await response.json()) as ScraperServiceResult;
    if (
      !payload.ok ||
      payload.blocked ||
      typeof payload.status !== "number" ||
      typeof payload.html !== "string"
    ) {
      console.warn("VPS scraper did not return a usable page", payload.blockReason ?? payload.error ?? "unknown error");
      return null;
    }
    return {
      status: payload.status,
      headers: new Headers(payload.headers ?? {}),
      html: payload.html,
      responseMs: payload.responseMs ?? Date.now() - startedAt,
      source: "vps",
    };
  } catch (err) {
    console.warn("VPS scraper fallback failed", err);
    return null;
  }
}

async function loadReaderPage(env: Env, url: string): Promise<LoadedPage | null> {
  if (!supportsReaderFallback(url)) return null;
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-retain-images": "none",
    "x-token-budget": "8000",
    "x-timeout": "20",
    "x-no-cache": "true",
  };
  if (env.JINA_API_KEY) headers.authorization = `Bearer ${env.JINA_API_KEY}`;

  try {
    const response = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, 30000);
    if (!response.ok) {
      console.warn("Reader fallback failed", response.status, await response.text().catch(() => ""));
      return null;
    }
    const payload = (await response.json()) as ReaderResult;
    const title = payload.data?.title?.trim();
    const content = payload.data?.content?.trim();
    if (!content) return null;
    const readerProbe = `<title>${title ?? ""}</title>${content}`;
    if (detectChallenge(200, new Headers(), readerProbe)) {
      console.warn("Reader returned a challenge page", title ?? "(no title)");
      return null;
    }
    if (supportsReaderFallback(url) && !/Код\s*:\s*\d+/i.test(content)) {
      console.warn("Reader response did not contain a Rozetka product code", title ?? "(no title)");
      return null;
    }
    // Wrap the extracted text in inert HTML so the existing parsing pipeline
    // can hash and inspect it without treating Markdown fragments as markup.
    const html = `<html><head><title>${escapeAsHtmlText(title ?? "")}</title></head><body><pre>${escapeAsHtmlText(content)}</pre></body></html>`;
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/html", "x-site-watch-source": "reader" }),
      html,
      responseMs: Date.now() - startedAt,
      source: "reader",
    };
  } catch (err) {
    console.warn("Reader fallback failed", err);
    return null;
  }
}

// A hung/very slow site would otherwise tie up its whole cron batch until
// Cloudflare's own subrequest ceiling kicks in — bound it explicitly instead.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      seller: null,
      responseMs: null,
      pageSizeBytes: null,
      platform: null,
      hosting: null,
      securityHeaders: null,
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
      seller: null,
      responseMs: null,
      pageSizeBytes: null,
      platform: null,
      hosting: null,
      securityHeaders: null,
      error: "Steam API тимчасово недоступний, спробую при наступній перевірці",
    };
  }

  try {
    let page = await loadDirectPage(url);
    let challenge = detectChallenge(page.status, page.headers, page.html);
    const directText = htmlToText(page.html);
    const directOk = page.status >= 200 && page.status < 300 && !challenge;

    let directSelectorText = "";
    if (selector && directOk) {
      const directResponse = new Response(page.html, { status: page.status, headers: page.headers });
      directSelectorText = selector.startsWith("auto:")
        ? await extractByAutoSpec(directResponse, selector)
        : await extractBySelector(directResponse, selector);
    }

    // Chromium is a fallback, not the default: it costs browser time and is
    // only useful when HTTP alone cannot produce the real page.
    const shouldRender =
      Boolean(challenge) ||
      page.status === 503 ||
      (directOk && looksLikeJavaScriptShell(page.html, directText)) ||
      Boolean(directOk && selector && !directSelectorText);
    let needsVps = shouldRender;
    if (shouldRender) {
      const rendered = await loadRenderedPage(env, url);
      if (rendered) {
        const renderedChallenge = detectChallenge(rendered.status, rendered.headers, rendered.html);
        if (!renderedChallenge && rendered.status >= 200 && rendered.status < 300) {
          page = rendered;
          challenge = null;
          needsVps = false;
        } else {
          challenge = renderedChallenge ?? `browser HTTP ${rendered.status}`;
        }
      }
    }

    // The VPS runs a normal Chromium process, keeps a per-site session and has
    // a different network origin than Cloudflare. It remains a fallback: easy
    // pages should not consume VPS browser resources.
    if (challenge || needsVps) {
      const vpsPage = await loadVpsPage(env, url, selector);
      if (vpsPage) {
        const vpsChallenge = detectChallenge(vpsPage.status, vpsPage.headers, vpsPage.html);
        if (!vpsChallenge && vpsPage.status >= 200 && vpsPage.status < 300) {
          page = vpsPage;
          challenge = null;
        } else {
          challenge = vpsChallenge ?? `VPS browser HTTP ${vpsPage.status}`;
        }
      }
    }

    // Rozetka has one final domain-scoped text fallback. No other watched URL
    // is sent to Reader.
    if (challenge) {
      const readerPage = await loadReaderPage(env, url);
      if (readerPage) {
        page = readerPage;
        challenge = null;
      }
    }

    const { status, responseMs, html } = page;
    const ok = status >= 200 && status < 300 && !challenge;

    if (challenge) {
      return {
        // Access-layer failures are not the site's real uptime status. The
        // monitor tracks and debounces this error separately while preserving
        // the last known-good status, price, stock and title.
        status: null,
        sslOk: true,
        title: null,
        textHash: null,
        value: null,
        content: null,
        price: null,
        priceTrusted: false,
        stock: null,
        seller: null,
        responseMs,
        pageSizeBytes: null,
        platform: null,
        hosting: detectHosting(page.headers),
        securityHeaders: detectSecurityHeaders(page.headers),
        error: `Сайт показав захист від автоматизованих запитів (${challenge})`,
      };
    }

    if (selector) {
      // Never extract values from an error page just because it happens to
      // contain a matching class name.
      if (!ok) {
        return {
          status,
          sslOk: true,
          title: null,
          textHash: null,
          value: null,
          content: null,
          price: null,
          priceTrusted: false,
          stock: null,
          seller: null,
          responseMs,
          pageSizeBytes: null,
          platform: null,
          hosting: detectHosting(page.headers),
          securityHeaders: detectSecurityHeaders(page.headers),
        };
      }
      const title = extractTitle(html);
      const selectorResponse = new Response(html, { status, headers: page.headers });
      const text = page.source === "direct" && directSelectorText
        ? directSelectorText
        : selector.startsWith("auto:")
          ? await extractByAutoSpec(selectorResponse, selector)
          : await extractBySelector(selectorResponse, selector);
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
          seller: null,
          responseMs,
          pageSizeBytes: null,
          platform: null,
          hosting: null,
          securityHeaders: null,
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
        seller: null,
        responseMs,
        pageSizeBytes: null,
        platform: null,
        hosting: null,
        securityHeaders: null,
      };
    }

    const text = htmlToText(html);
    const structured = ok ? extractStructuredData(html) : { title: null, price: null, stock: null, seller: null };
    const rozetka = ok && page.source === "reader" ? extractRozetkaData(text) : null;
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
      price: ok ? structured.price ?? rozetka?.price ?? extractPrice(text) : null,
      priceTrusted: Boolean(structured.price || rozetka?.price),
      stock: ok ? structured.stock ?? rozetka?.stock ?? extractStock(text) : null,
      seller: ok ? structured.seller : null,
      // "Site info" — technical facts about the site itself rather than any
      // product on it, shown for every watch regardless of whether it's a
      // shop or a plain page (this is exactly what a portfolio/blog watch
      // has to offer beyond a bare status line).
      responseMs,
      pageSizeBytes: ok ? new TextEncoder().encode(html).length : null,
      platform: ok ? detectPlatform(html) : null,
      hosting: detectHosting(page.headers),
      securityHeaders: detectSecurityHeaders(page.headers),
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
      responseMs: null,
      pageSizeBytes: null,
      platform: null,
      hosting: null,
      securityHeaders: null,
      stock: null,
      seller: null,
      error: message,
    };
  }
}
