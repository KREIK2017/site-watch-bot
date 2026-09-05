import { analyzeUrl, BOT_USER_AGENT, fetchWithTimeout, findPriceCandidates, humanizeStatus } from "./checker";
import { convertPrice, getChatCurrency, setChatCurrency } from "./currency";
import { formatHistoryDate, getHistory, recordHistory } from "./history";
import { answerCallbackQuery, editMessageText, escapeHtml, sendMainMenu, sendMessage, watchLink } from "./telegram";
import type { Env, InlineKeyboardButton, TelegramCallbackQuery, TelegramMessage, WatchRow } from "./types";

const MAX_WATCHES_PER_CHAT = 20;

function formatResponseTime(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} с` : `${ms} мс`;
}

function formatPageSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${bytes} B`;
}

// Facts about the site itself (not any product on it) — response time and
// page size are available for every watch; platform/hosting/security
// headers only for a plain (no-selector) page fetch.
function buildSiteInfoLines(
  w: Pick<WatchRow, "last_response_ms" | "last_page_size" | "last_platform" | "last_hosting" | "last_security_headers">
): string[] {
  const lines: string[] = [];
  if (w.last_response_ms !== null) lines.push(`⏱ Відповідь: ${formatResponseTime(w.last_response_ms)}`);
  if (w.last_page_size !== null) lines.push(`📦 Розмір сторінки: ${formatPageSize(w.last_page_size)}`);
  if (w.last_platform) lines.push(`🧩 Платформа: ${escapeHtml(w.last_platform)}`);
  if (w.last_hosting) lines.push(`☁️ Хостинг/CDN: ${escapeHtml(w.last_hosting)}`);
  if (w.last_security_headers) lines.push(`🔒 Заголовки безпеки: ${escapeHtml(w.last_security_headers)}`);
  return lines;
}

const CURRENCY_OPTIONS: { code: string; label: string }[] = [
  { code: "UAH", label: "🇺🇦 UAH" },
  { code: "USD", label: "🇺🇸 USD" },
  { code: "EUR", label: "🇪🇺 EUR" },
  { code: "GBP", label: "🇬🇧 GBP" },
  { code: "PLN", label: "🇵🇱 PLN" },
];

function currencyKeyboard(): InlineKeyboardButton[][] {
  return [
    [CURRENCY_OPTIONS[0], CURRENCY_OPTIONS[1]].map((c) => ({ text: c.label, callback_data: `curr:${c.code}` })),
    [CURRENCY_OPTIONS[2], CURRENCY_OPTIONS[3]].map((c) => ({ text: c.label, callback_data: `curr:${c.code}` })),
    [{ text: CURRENCY_OPTIONS[4].label, callback_data: `curr:${CURRENCY_OPTIONS[4].code}` }],
  ];
}

// "auto:<rule>:<index>" is an internal addressing scheme from the candidate
// picker, meaningless to a user — only show a selector back when they typed
// it themselves.
function describeSelector(selector: string | null): string | null {
  if (!selector || selector.startsWith("auto:")) return null;
  return `Елемент: <code>${escapeHtml(selector)}</code>`;
}

const WELCOME_TEXT = `<b>Site Watch Bot</b>
Слідкую за сайтами і повідомляю про зміни ціни, наявності, статусу сторінки чи вмісту.

Користуйся кнопками знизу або команда <code>/help</code> для повної довідки.`;

const HELP_TEXT = `<b>Site Watch Bot</b>
Слідкую за сайтами і повідомляю про зміни ціни, наявності, статусу чи вмісту сторінки.

<b>Команди:</b>
/watch &lt;url&gt; — почати стежити
/list — мої сайти (тисни ⚙️ #id, щоб керувати конкретним)
/check &lt;id&gt; — перевірити зараз
/history &lt;id&gt; — історія цін/наявності
/rename &lt;id&gt; &lt;назва&gt; — перейменувати
/pause &lt;id&gt; — призупинити перевірки
/resume &lt;id&gt; — відновити перевірки
/unwatch &lt;id&gt; — прибрати зі списку
/currency — обрати валюту показу цін
/help — ця довідка

<b>Приклади:</b>
<code>/watch https://example.com/product</code>
<code>/watch https://store.steampowered.com/app/12345/GameName</code>

Можна просто вставити посилання в чат без команди — теж спрацює.`;

// Opening the product page is the clickable name link in the message text
// (watchLink) — Telegram opens plain in-message links in its own in-app
// browser by default, so a separate button for it is redundant.
//
// Full action set for ONE watch — used on its own confirmation message
// (/watch, freshly created) and on the single-item "management card" (see
// buildDetailView). Never attached to the multi-item /list message: with
// several watches, stacking every action for every row made it impossible
// to tell which button belonged to which line (Telegram always renders all
// of a message's buttons as one block at the very bottom, not next to the
// line they relate to).
function actionRows(
  w: { id: number; price: string | null; priceTrusted: boolean; paused: boolean },
  opts: { back?: boolean } = {}
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    [
      { text: "🔄 Перевірити", callback_data: `chk:${w.id}` },
      w.paused
        ? { text: "▶️ Відновити", callback_data: `res:${w.id}` }
        : { text: "⏸ Пауза", callback_data: `pau:${w.id}` },
    ],
    [{ text: "🗑 Видалити", callback_data: `unw:${w.id}` }],
  ];
  if (w.price && !w.priceTrusted) {
    rows.push([{ text: "❔ Не та ціна?", callback_data: `fix:${w.id}` }]);
  }
  if (opts.back) {
    rows.push([{ text: "⬅️ До списку", callback_data: "back" }]);
  }
  return rows;
}

// The /list overview instead gets one small "⚙️ #id" button per watch, a few
// per row — tapping one opens that single watch's management card.
function manageButtonRows(ids: number[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < ids.length; i += 4) {
    rows.push(ids.slice(i, i + 4).map((id) => ({ text: `⚙️ #${id}`, callback_data: `mgr:${id}` })));
  }
  return rows;
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

function parseWatchArgs(arg: string): { url: string; selector: string | null } | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;

  const firstSpace = trimmed.search(/\s/);
  const urlPart = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const url = normalizeUrl(urlPart);
  if (!url) return null;

  let selector: string | null = firstSpace === -1 ? null : trimmed.slice(firstSpace + 1).trim();
  if (selector) {
    selector = selector.replace(/^["']|["']$/g, "").trim() || null;
  }
  return { url, selector };
}

// Splits "<id> <rest>" for /rename — id must be the first token, the rest
// (possibly containing spaces) is the new name.
function parseIdAndText(arg: string): { id: number; text: string } | null {
  const trimmed = arg.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return null;
  const id = Number(trimmed.slice(0, firstSpace));
  const text = trimmed.slice(firstSpace + 1).trim();
  if (!Number.isInteger(id) || !text) return null;
  return { id, text };
}

async function handleWatch(env: Env, chatId: number, arg: string): Promise<void> {
  const parsed = parseWatchArgs(arg);
  if (!parsed) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "Вкажи посилання: <code>/watch https://example.com</code>\nЩоб стежити за конкретним товаром, додай CSS-селектор: <code>/watch https://example.com/product .price</code>"
    );
    return;
  }
  const { url, selector } = parsed;

  const existing = await env.DB.prepare(
    "SELECT id FROM watches WHERE chat_id = ? AND url = ? AND active = 1 AND COALESCE(selector, '') = COALESCE(?, '')"
  )
    .bind(chatId, url, selector)
    .first<{ id: number }>();
  if (existing) {
    await sendMessage(env.BOT_TOKEN, chatId, `Вже стежу за цим сайтом (id ${existing.id}).`);
    return;
  }

  const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM watches WHERE chat_id = ? AND active = 1")
    .bind(chatId)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= MAX_WATCHES_PER_CHAT) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `Досягнуто ліміту ${MAX_WATCHES_PER_CHAT} сайтів на чат. Прибери щось непотрібне через /list, щоб додати нове.`
    );
    return;
  }

  const baseline = await analyzeUrl(env, url, selector);
  const inserted = await env.DB.prepare(
    `INSERT INTO watches (chat_id, url, label, selector, last_status, last_hash, last_price, price_trusted, last_stock, last_value, last_content, last_response_ms, last_page_size, last_platform, last_hosting, last_security_headers, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`
  )
    .bind(
      chatId,
      url,
      baseline.title,
      selector,
      baseline.status,
      baseline.textHash,
      baseline.price,
      baseline.priceTrusted ? 1 : 0,
      baseline.stock,
      baseline.value,
      baseline.content,
      baseline.responseMs,
      baseline.pageSizeBytes,
      baseline.platform,
      baseline.hosting,
      baseline.securityHeaders
    )
    .first<{ id: number }>();

  if (inserted && (baseline.price || baseline.stock)) {
    await recordHistory(env, inserted.id, baseline.price, baseline.stock, baseline.status);
  }

  const lines = [`✅ Стежу за <b>${watchLink(url, baseline.title)}</b> (id ${inserted?.id})`];
  const selectorLine = describeSelector(selector);
  if (selectorLine) lines.push(selectorLine);
  if (baseline.error) {
    lines.push(`⚠️ ${escapeHtml(baseline.error)}`);
  } else {
    lines.push(`Статус: ${humanizeStatus(baseline.status)}`);
    if (baseline.price) {
      const currency = await getChatCurrency(env, chatId);
      const priceDisplay = await convertPrice(env, baseline.price, currency);
      lines.push(`Ціна: ${escapeHtml(priceDisplay ?? baseline.price)}`);
    }
    if (baseline.stock) lines.push(`Наявність: ${escapeHtml(baseline.stock)}`);
    if (!baseline.price && !baseline.stock && baseline.value) {
      lines.push(`Значення: ${escapeHtml(baseline.value)}`);
    }
    const siteInfo = buildSiteInfoLines({
      last_response_ms: baseline.responseMs,
      last_page_size: baseline.pageSizeBytes,
      last_platform: baseline.platform,
      last_hosting: baseline.hosting,
      last_security_headers: baseline.securityHeaders,
    });
    if (siteInfo.length) lines.push("", "🔧 <b>Технічна інформація</b>", ...siteInfo);
  }
  const keyboard = inserted
    ? actionRows({ id: inserted.id, price: baseline.price, priceTrusted: baseline.priceTrusted, paused: false })
    : undefined;
  await sendMessage(env.BOT_TOKEN, chatId, lines.join("\n"), keyboard);
}

type ListRow = Pick<
  WatchRow,
  | "id"
  | "url"
  | "label"
  | "selector"
  | "last_status"
  | "last_price"
  | "price_trusted"
  | "last_stock"
  | "last_value"
  | "paused"
>;

async function buildListView(
  env: Env,
  chatId: number
): Promise<{ text: string; keyboard: InlineKeyboardButton[][] }> {
  const { results } = await env.DB.prepare(
    "SELECT id, url, label, selector, last_status, last_price, price_trusted, last_stock, last_value, paused FROM watches WHERE chat_id = ? AND active = 1 ORDER BY id"
  )
    .bind(chatId)
    .all<ListRow>();

  if (!results.length) {
    return { text: "Список порожній. Додай сайт: <code>/watch https://example.com</code>", keyboard: [] };
  }

  const currency = await getChatCurrency(env, chatId);
  const lines = await Promise.all(
    results.map(async (w) => {
      const parts = [`#${w.id} ${watchLink(w.url, w.label)}`];
      if (w.paused) parts.push("⏸ на паузі");
      else parts.push(humanizeStatus(w.last_status));
      const priceDisplay = await convertPrice(env, w.last_price, currency);
      if (priceDisplay) parts.push(`ціна ${escapeHtml(priceDisplay)}`);
      if (w.last_stock) parts.push(escapeHtml(w.last_stock));
      if (!w.last_price && !w.last_stock && w.last_value) parts.push(escapeHtml(w.last_value));
      if (w.selector) parts.push("🎯");
      return parts.join(" — ");
    })
  );

  return {
    text: lines.join("\n"),
    keyboard: manageButtonRows(results.map((w) => w.id)),
  };
}

async function handleList(env: Env, chatId: number): Promise<void> {
  const { text, keyboard } = await buildListView(env, chatId);
  await sendMessage(env.BOT_TOKEN, chatId, text, keyboard.length ? keyboard : undefined);
}

// The single-watch "management card" a "⚙️ #id" button opens — full detail,
// full action set, and a way back to the overview. Reused after any action
// taken from the card (check/pause/resume) so the card refreshes in place.
async function buildDetailView(
  env: Env,
  chatId: number,
  id: number
): Promise<{ text: string; keyboard: InlineKeyboardButton[][] } | null> {
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) return null;

  const lines = [`<b>${watchLink(watch.url, watch.label)}</b> (id ${watch.id})`];
  if (watch.paused) lines.push("⏸ На паузі — перевірки не виконуються");
  const selectorLine = describeSelector(watch.selector);
  if (selectorLine) lines.push(selectorLine);
  lines.push(`Статус: ${humanizeStatus(watch.last_status)}`);
  const currency = await getChatCurrency(env, chatId);
  const priceDisplay = await convertPrice(env, watch.last_price, currency);
  if (priceDisplay) lines.push(`Ціна: ${escapeHtml(priceDisplay)}`);
  if (watch.last_stock) lines.push(`Наявність: ${escapeHtml(watch.last_stock)}`);
  if (!watch.last_price && !watch.last_stock && watch.last_value) {
    lines.push(`Значення: ${escapeHtml(watch.last_value)}`);
  }
  const siteInfo = buildSiteInfoLines(watch);
  if (siteInfo.length) lines.push("", "🔧 <b>Технічна інформація</b>", ...siteInfo);

  return {
    text: lines.join("\n"),
    keyboard: actionRows(
      { id: watch.id, price: watch.last_price, priceTrusted: Boolean(watch.price_trusted), paused: Boolean(watch.paused) },
      { back: true }
    ),
  };
}

async function handleUnwatch(env: Env, chatId: number, arg: string): Promise<void> {
  const id = Number(arg.trim());
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, "Вкажи id зі списку: <code>/unwatch 3</code>");
    return;
  }
  const result = await env.DB.prepare(
    "UPDATE watches SET active = 0 WHERE id = ? AND chat_id = ? AND active = 1"
  )
    .bind(id, chatId)
    .run();
  const changed = result.meta.changes ?? 0;
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    changed > 0 ? `Прибрав id ${id} зі списку.` : `Не знайшов активний watch з id ${id}.`
  );
}

async function handleRename(env: Env, chatId: number, arg: string): Promise<void> {
  const parsed = parseIdAndText(arg);
  if (!parsed) {
    await sendMessage(env.BOT_TOKEN, chatId, "Формат: <code>/rename 3 Нова назва</code>");
    return;
  }
  const result = await env.DB.prepare("UPDATE watches SET label = ? WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(parsed.text, parsed.id, chatId)
    .run();
  const changed = result.meta.changes ?? 0;
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    changed > 0 ? `Перейменовано id ${parsed.id} на «${parsed.text}».` : `Не знайшов активний watch з id ${parsed.id}.`
  );
}

async function setPaused(env: Env, chatId: number, id: number, paused: boolean): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE watches SET paused = ? WHERE id = ? AND chat_id = ? AND active = 1"
  )
    .bind(paused ? 1 : 0, id, chatId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function handlePauseCommand(env: Env, chatId: number, arg: string, paused: boolean): Promise<void> {
  const id = Number(arg.trim());
  const usage = paused ? "/pause 3" : "/resume 3";
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, `Вкажи id зі списку: <code>${usage}</code>`);
    return;
  }
  const changed = await setPaused(env, chatId, id, paused);
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    changed
      ? paused
        ? `⏸ Призупинив перевірки для id ${id}.`
        : `▶️ Відновив перевірки для id ${id}.`
      : `Не знайшов активний watch з id ${id}.`
  );
}

async function handleHistory(env: Env, chatId: number, arg: string): Promise<void> {
  const id = Number(arg.trim());
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, "Вкажи id зі списку: <code>/history 3</code>");
    return;
  }
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ?")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) {
    await sendMessage(env.BOT_TOKEN, chatId, `Не знайшов watch з id ${id}.`);
    return;
  }

  const entries = await getHistory(env, id);
  if (!entries.length) {
    await sendMessage(env.BOT_TOKEN, chatId, "Історії ще немає — зачекай на першу зафіксовану зміну.");
    return;
  }

  const currency = await getChatCurrency(env, chatId);
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const parts = [formatHistoryDate(entry.checked_at)];
      const priceDisplay = await convertPrice(env, entry.price, currency);
      if (priceDisplay) parts.push(escapeHtml(priceDisplay));
      if (entry.stock) parts.push(escapeHtml(entry.stock));
      return parts.join(" — ");
    })
  );

  await sendMessage(env.BOT_TOKEN, chatId, `<b>${watchLink(watch.url, watch.label)}</b>\n\n${lines.join("\n")}`);
}

async function runCheck(env: Env, chatId: number, id: number): Promise<{ text: string; watch: WatchRow } | null> {
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) return null;

  const result = await analyzeUrl(env, watch.url, watch.selector);
  // A blocked/challenged check returns nulls for hash/price/stock; COALESCE
  // keeps the last known-good values instead of wiping them out.
  await env.DB.prepare(
    `UPDATE watches SET
       label = COALESCE(?, label),
       last_status = ?,
       last_hash = COALESCE(?, last_hash),
       last_price = COALESCE(?, last_price),
       price_trusted = CASE WHEN ? IS NOT NULL THEN ? ELSE price_trusted END,
       last_stock = COALESCE(?, last_stock),
       last_value = COALESCE(?, last_value),
       last_content = COALESCE(?, last_content),
       last_response_ms = COALESCE(?, last_response_ms),
       last_page_size = COALESCE(?, last_page_size),
       last_platform = COALESCE(?, last_platform),
       last_hosting = COALESCE(?, last_hosting),
       last_security_headers = COALESCE(?, last_security_headers),
       last_checked_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      result.title,
      result.status,
      result.textHash,
      result.price,
      result.price,
      result.priceTrusted ? 1 : 0,
      result.stock,
      result.value,
      result.content,
      result.responseMs,
      result.pageSizeBytes,
      result.platform,
      result.hosting,
      result.securityHeaders,
      id
    )
    .run();

  const isBaseline = watch.last_hash === null;
  const priceChanged = Boolean(result.price) && result.price !== watch.last_price;
  const stockChanged = Boolean(result.stock) && result.stock !== watch.last_stock;
  if (isBaseline || priceChanged || stockChanged) {
    await recordHistory(env, id, result.price ?? watch.last_price, result.stock ?? watch.last_stock, result.status);
  }

  const lines = [`<b>${watchLink(watch.url, watch.label ?? result.title)}</b>`];
  const selectorLine = describeSelector(watch.selector);
  if (selectorLine) lines.push(selectorLine);
  if (result.error) {
    lines.push(`⚠️ ${escapeHtml(result.error)}`);
  } else {
    lines.push(`Статус: ${humanizeStatus(result.status)}`);
    if (result.price) {
      const currency = await getChatCurrency(env, chatId);
      const priceDisplay = await convertPrice(env, result.price, currency);
      lines.push(`Ціна: ${escapeHtml(priceDisplay ?? result.price)}`);
    }
    if (result.stock) lines.push(`Наявність: ${escapeHtml(result.stock)}`);
    if (!result.price && !result.stock && result.value) {
      lines.push(`Значення: ${escapeHtml(result.value)}`);
    }
    const siteInfo = buildSiteInfoLines({
      last_response_ms: result.responseMs,
      last_page_size: result.pageSizeBytes,
      last_platform: result.platform,
      last_hosting: result.hosting,
      last_security_headers: result.securityHeaders,
    });
    if (siteInfo.length) lines.push("", "🔧 <b>Технічна інформація</b>", ...siteInfo);
  }
  return { text: lines.join("\n"), watch };
}

async function handleCheck(env: Env, chatId: number, arg: string): Promise<void> {
  const id = Number(arg.trim());
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, "Вкажи id зі списку: <code>/check 3</code>");
    return;
  }
  const outcome = await runCheck(env, chatId, id);
  if (!outcome) {
    await sendMessage(env.BOT_TOKEN, chatId, `Не знайшов активний watch з id ${id}.`);
    return;
  }
  await sendMessage(env.BOT_TOKEN, chatId, outcome.text);
}

// Bare-domain heuristic (no scheme required) so pasting a link straight into
// the chat works the same as /watch, without the user needing to know the command.
function looksLikeUrl(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(token);
}

export async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();

  if (!text.startsWith("/")) {
    if (text === "📋 Мої сайти") return handleList(env, chatId);
    if (text === "❓ Допомога") {
      await sendMessage(env.BOT_TOKEN, chatId, HELP_TEXT);
      return;
    }
    if (text === "➕ Додати сайт") {
      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        "Надішли посилання на сайт (за бажанням через пробіл додай CSS-селектор товару), напр.:\nhttps://example.com\nhttps://example.com/product .price"
      );
      return;
    }
    const firstToken = text.split(/\s+/)[0] ?? "";
    if (looksLikeUrl(firstToken)) {
      await handleWatch(env, chatId, text);
    }
    return;
  }

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const arg = rest.join(" ");

  switch (command) {
    case "/start": {
      await sendMainMenu(env.BOT_TOKEN, chatId, WELCOME_TEXT);
      const currency = await getChatCurrency(env, chatId);
      if (!currency) {
        await sendMessage(env.BOT_TOKEN, chatId, "В якій валюті показувати ціни?", currencyKeyboard());
      }
      break;
    }
    case "/help":
      await sendMessage(env.BOT_TOKEN, chatId, HELP_TEXT);
      break;
    case "/watch":
      await handleWatch(env, chatId, arg);
      break;
    case "/list":
      await handleList(env, chatId);
      break;
    case "/unwatch":
      await handleUnwatch(env, chatId, arg);
      break;
    case "/check":
      await handleCheck(env, chatId, arg);
      break;
    case "/history":
      await handleHistory(env, chatId, arg);
      break;
    case "/rename":
      await handleRename(env, chatId, arg);
      break;
    case "/pause":
      await handlePauseCommand(env, chatId, arg, true);
      break;
    case "/resume":
      await handlePauseCommand(env, chatId, arg, false);
      break;
    case "/currency":
      await sendMessage(env.BOT_TOKEN, chatId, "В якій валюті показувати ціни?", currencyKeyboard());
      break;
    default:
      await sendMessage(env.BOT_TOKEN, chatId, "Не знаю такої команди. /help — список команд.");
  }
}

async function handleFixButton(env: Env, chatId: number, queryId: string, id: number): Promise<void> {
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) {
    await answerCallbackQuery(env.BOT_TOKEN, queryId, "Не знайдено");
    return;
  }

  let candidates: Awaited<ReturnType<typeof findPriceCandidates>> = [];
  try {
    const res = await fetchWithTimeout(watch.url, { redirect: "follow", headers: { "user-agent": BOT_USER_AGENT } });
    candidates = await findPriceCandidates(res);
  } catch {
    // fall through with an empty list, handled below
  }

  if (!candidates.length) {
    await answerCallbackQuery(env.BOT_TOKEN, queryId, "Не знайшов інших варіантів на сторінці");
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, queryId);
  const rows = candidates.map((c) => [
    { text: `💰 ${c.value}`, callback_data: `pick:${id}:${c.ruleId}:${c.index}` },
  ]);
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    `Знайшов кілька можливих значень ціни на <b>${watchLink(watch.url, watch.label)}</b>. Яке правильне?`,
    rows
  );
}

async function handlePickCandidate(
  env: Env,
  chatId: number,
  queryId: string,
  id: number,
  ruleId: string,
  indexRaw: string
): Promise<void> {
  const selector = `auto:${ruleId}:${indexRaw}`;
  const result = await env.DB.prepare(
    "UPDATE watches SET selector = ? WHERE id = ? AND chat_id = ? AND active = 1"
  )
    .bind(selector, id, chatId)
    .run();
  if (!(result.meta.changes ?? 0)) {
    await answerCallbackQuery(env.BOT_TOKEN, queryId, "Не знайдено");
    return;
  }

  const outcome = await runCheck(env, chatId, id);
  await answerCallbackQuery(env.BOT_TOKEN, queryId, "Збережено ✅");
  if (outcome) await sendMessage(env.BOT_TOKEN, chatId, outcome.text);
}

export async function handleCallbackQuery(env: Env, query: TelegramCallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data ?? "";
  const [action, idRaw, ...rest] = data.split(":");

  if (!chatId) {
    await answerCallbackQuery(env.BOT_TOKEN, query.id, "Кнопка застаріла");
    return;
  }

  if (action === "curr") {
    await setChatCurrency(env, chatId, idRaw);
    await answerCallbackQuery(env.BOT_TOKEN, query.id, `Валюта: ${idRaw} ✅`);
    return;
  }

  if (action === "back") {
    if (messageId) {
      const { text, keyboard } = await buildListView(env, chatId);
      await editMessageText(env.BOT_TOKEN, chatId, messageId, text, keyboard);
    }
    await answerCallbackQuery(env.BOT_TOKEN, query.id);
    return;
  }

  const id = Number(idRaw);
  if (!messageId || !Number.isInteger(id)) {
    await answerCallbackQuery(env.BOT_TOKEN, query.id, "Кнопка застаріла, онови список через /list");
    return;
  }

  if (action === "mgr") {
    const detail = await buildDetailView(env, chatId, id);
    await answerCallbackQuery(env.BOT_TOKEN, query.id, detail ? undefined : "Не знайдено");
    if (detail) await editMessageText(env.BOT_TOKEN, chatId, messageId, detail.text, detail.keyboard);
    return;
  }

  if (action === "chk") {
    const outcome = await runCheck(env, chatId, id);
    await answerCallbackQuery(env.BOT_TOKEN, query.id, outcome ? "Перевірено ✅" : "Не знайдено");
    if (outcome) {
      const detail = await buildDetailView(env, chatId, id);
      if (detail) await editMessageText(env.BOT_TOKEN, chatId, messageId, detail.text, detail.keyboard);
    }
    return;
  }

  if (action === "unw") {
    const result = await env.DB.prepare(
      "UPDATE watches SET active = 0 WHERE id = ? AND chat_id = ? AND active = 1"
    )
      .bind(id, chatId)
      .run();
    const changed = result.meta.changes ?? 0;
    await answerCallbackQuery(env.BOT_TOKEN, query.id, changed > 0 ? "Прибрано" : "Не знайдено");
    if (changed > 0) {
      const { text, keyboard } = await buildListView(env, chatId);
      await editMessageText(env.BOT_TOKEN, chatId, messageId, text, keyboard);
    }
    return;
  }

  if (action === "pau" || action === "res") {
    const changed = await setPaused(env, chatId, id, action === "pau");
    await answerCallbackQuery(
      env.BOT_TOKEN,
      query.id,
      changed ? (action === "pau" ? "⏸ Пауза" : "▶️ Відновлено") : "Не знайдено"
    );
    if (changed) {
      const detail = await buildDetailView(env, chatId, id);
      if (detail) await editMessageText(env.BOT_TOKEN, chatId, messageId, detail.text, detail.keyboard);
    }
    return;
  }

  if (action === "fix") {
    await handleFixButton(env, chatId, query.id, id);
    return;
  }

  if (action === "pick") {
    const [ruleId, indexRaw] = rest;
    if (ruleId && indexRaw) {
      await handlePickCandidate(env, chatId, query.id, id, ruleId, indexRaw);
      return;
    }
  }

  await answerCallbackQuery(env.BOT_TOKEN, query.id);
}
