import type { AnalyzeResult } from "./types";

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

// One dollar/euro/pound/hryvnia sign (or 3-letter code) glued to a number, in either order.
const PRICE_RE =
  /(?:[$€£₴¥]\s?\d[\d\s.,]{0,12}\d|\d[\d\s.,]{0,12}\d\s?(?:USD|EUR|UAH|GBP|\$|€|£|₴))/i;

export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutNoise.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded.replace(/\s+/g, " ").trim();
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

// Finds a Product/Offer node in a JSON-LD document, which may be a single
// object, an array of objects, or wrapped in a top-level "@graph" array —
// all three shapes are common across e-commerce platforms.
function findOffer(node: unknown): { price?: unknown; priceCurrency?: unknown; availability?: unknown } | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOffer(item);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("Product") && obj.offers) {
    const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
    if (offer && typeof offer === "object") {
      return offer as { price?: unknown; priceCurrency?: unknown; availability?: unknown };
    }
  }
  if (obj["@graph"]) return findOffer(obj["@graph"]);
  return null;
}

// Most modern storefronts (Shopify, WooCommerce, PrestaShop, Wix...) embed the
// price/availability as static Schema.org JSON-LD or Open Graph meta tags —
// meant for Google, but it means the real price often exists in the raw HTML
// even on sites where the *visible* price is drawn in later by JavaScript.
// Checking this first lets most /watch calls skip the CSS-selector step.
function extractStructuredData(html: string): { price: string | null; stock: string | null } {
  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const scriptMatch of scripts) {
    try {
      const offer = findOffer(JSON.parse(scriptMatch[1].trim()));
      if (!offer) continue;
      const rawPrice = offer.price !== undefined && offer.price !== null ? String(offer.price).trim() : null;
      const currency = typeof offer.priceCurrency === "string" ? offer.priceCurrency : null;
      const price = rawPrice ? withCurrency(rawPrice, currency) : null;
      const stock = typeof offer.availability === "string" ? mapAvailability(offer.availability) : null;
      if (price || stock) return { price, stock };
    } catch {
      // Malformed JSON-LD is common in the wild; just skip that block.
    }
  }

  const metaPrice = html.match(
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|price)["'][^>]+content=["']([^"']+)["']/i
  );
  if (!metaPrice) return { price: null, stock: null };
  const metaCurrency = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["']/i);
  return { price: withCurrency(metaPrice[1].trim(), metaCurrency?.[1] ?? null), stock: null };
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

export async function analyzeUrl(url: string, selector?: string | null): Promise<AnalyzeResult> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": BOT_USER_AGENT },
    });
    const status = res.status;

    if (selector) {
      const text = selector.startsWith("auto:")
        ? await extractByAutoSpec(res, selector)
        : await extractBySelector(res, selector);
      if (!text) {
        return {
          status,
          sslOk: true,
          textHash: null,
          price: null,
          stock: null,
          error: `Селектор "${selector}" нічого не знайшов на сторінці`,
        };
      }
      return {
        status,
        sslOk: true,
        textHash: await sha256(text),
        price: extractPrice(text),
        stock: extractStock(text),
      };
    }

    const html = await res.text();
    const text = htmlToText(html);
    const structured = extractStructuredData(html);
    return {
      status,
      sslOk: true,
      textHash: await sha256(text),
      price: structured.price ?? extractPrice(text),
      stock: structured.stock ?? extractStock(text),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sslOk = !/ssl|certificate|tls/i.test(message);
    return { status: null, sslOk, textHash: null, price: null, stock: null, error: message };
  }
}
