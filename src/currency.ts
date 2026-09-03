import type { Env } from "./types";

export const SUPPORTED_CURRENCIES = ["UAH", "USD", "EUR", "GBP", "PLN"] as const;

const CURRENCY_SYMBOLS: Record<string, string> = {
  "₴": "UAH",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  zł: "PLN",
  лв: "BGN",
  "¥": "JPY",
};

const KNOWN_CODES = new Set(["UAH", "USD", "EUR", "GBP", "PLN", "BGN", "JPY", "CZK", "CHF", "CAD", "AUD"]);

export const CURRENCY_LABEL: Record<string, string> = {
  UAH: "грн",
  USD: "$",
  EUR: "€",
  GBP: "£",
  PLN: "zł",
  BGN: "лв",
  JPY: "¥",
};

// Best-effort money parser: handles "1 399₴", "36.32 BGN", "€49.99", "501.50"
// (no currency -> null, can't convert without knowing the source). Stripping
// everything but digits from the integer part makes it agnostic to whether
// "." or "," is used as the thousands separator in the source formatting.
export function parseMoney(input: string): { amount: number; currency: string } | null {
  const trimmed = input.trim();

  let currency: string | null = null;
  let rest = trimmed;

  const codeMatch = trimmed.match(/\b([A-Z]{3})\b/);
  if (codeMatch && KNOWN_CODES.has(codeMatch[1])) {
    currency = codeMatch[1];
    rest = trimmed.replace(codeMatch[0], "");
  } else {
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
      if (trimmed.includes(symbol)) {
        currency = code;
        rest = trimmed.split(symbol).join("");
        break;
      }
    }
  }
  if (!currency) return null;

  const numeric = rest.replace(/[^\d.,\s]/g, "").trim();
  if (!numeric) return null;

  const decimalMatch = numeric.match(/[.,](\d{1,2})$/);
  const fractionPart = decimalMatch ? decimalMatch[1] : "0";
  const integerPart = decimalMatch ? numeric.slice(0, numeric.length - decimalMatch[0].length) : numeric;
  const digitsOnly = integerPart.replace(/[^\d]/g, "");
  if (!digitsOnly) return null;

  const amount = Number(`${digitsOnly}.${fractionPart}`);
  return Number.isFinite(amount) ? { amount, currency } : null;
}

const RATE_CACHE_MS = 6 * 60 * 60 * 1000; // 6h — free API updates once a day anyway

async function getRate(env: Env, from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  const pair = `${from}_${to}`;

  const cached = await env.DB.prepare("SELECT rate, fetched_at FROM fx_rates WHERE pair = ?")
    .bind(pair)
    .first<{ rate: number; fetched_at: string }>();
  if (cached && Date.now() - new Date(`${cached.fetched_at}Z`).getTime() < RATE_CACHE_MS) {
    return cached.rate;
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    if (!res.ok) return cached?.rate ?? null;
    const json = (await res.json()) as { rates?: Record<string, number> };
    const rate = json.rates?.[to];
    if (!rate) return cached?.rate ?? null;

    await env.DB.prepare(
      `INSERT INTO fx_rates (pair, rate, fetched_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at`
    )
      .bind(pair, rate)
      .run();
    return rate;
  } catch {
    return cached?.rate ?? null;
  }
}

// Appends an approximate conversion in the chat's preferred currency, e.g.
// "23€ (≈ 1050 грн)". Returns the price unchanged when there's no preferred
// currency set, the source currency can't be determined, or it already
// matches the target.
export async function convertPrice(env: Env, price: string | null, targetCurrency: string | null): Promise<string | null> {
  if (!price || !targetCurrency) return price;
  const parsed = parseMoney(price);
  if (!parsed || parsed.currency === targetCurrency) return price;

  const rate = await getRate(env, parsed.currency, targetCurrency);
  if (!rate) return price;

  const converted = (parsed.amount * rate).toLocaleString("uk-UA", { maximumFractionDigits: 2 });
  const label = CURRENCY_LABEL[targetCurrency] ?? targetCurrency;
  return `${price} (≈ ${converted} ${label})`;
}

export async function getChatCurrency(env: Env, chatId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT currency FROM chat_settings WHERE chat_id = ?")
    .bind(chatId)
    .first<{ currency: string }>();
  return row?.currency ?? null;
}

export async function setChatCurrency(env: Env, chatId: number, currency: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO chat_settings (chat_id, currency) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET currency = excluded.currency`
  )
    .bind(chatId, currency)
    .run();
}
