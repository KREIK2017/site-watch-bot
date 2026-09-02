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
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

export function extractStock(text: string): string | null {
  const lower = text.toLowerCase();
  if (OUT_OF_STOCK_PATTERNS.some((p) => lower.includes(p))) return "Немає в наявності";
  if (IN_STOCK_PATTERNS.some((p) => lower.includes(p))) return "В наявності";
  return null;
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

// Scopes extraction to one element via Cloudflare's native streaming HTML
// parser, so /watch on a product page tracks that product instead of
// whichever price/availability text happens to appear first on the page.
async function extractBySelector(response: Response, selector: string): Promise<string> {
  let captured = "";
  const rewriter = new HTMLRewriter().on(selector, {
    text(chunk) {
      captured += chunk.text;
    },
  });
  await rewriter.transform(response).text();
  return captured.replace(/\s+/g, " ").trim();
}

export async function analyzeUrl(url: string, selector?: string | null): Promise<AnalyzeResult> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; SiteWatchBot/1.0)" },
    });
    const status = res.status;

    let text: string;
    if (selector) {
      text = await extractBySelector(res, selector);
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
    } else {
      const html = await res.text();
      text = htmlToText(html);
    }

    return {
      status,
      sslOk: true,
      textHash: await sha256(text),
      price: extractPrice(text),
      stock: extractStock(text),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sslOk = !/ssl|certificate|tls/i.test(message);
    return { status: null, sslOk, textHash: null, price: null, stock: null, error: message };
  }
}
