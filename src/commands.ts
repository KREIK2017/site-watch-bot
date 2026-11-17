import { analyzeUrl, BOT_USER_AGENT, fetchWithTimeout, findPriceCandidates } from "./checker";
import { convertPrice, getChatCurrency, setChatCurrency, setChatLanguage, SUPPORTED_CURRENCIES } from "./currency";
import { formatHistoryDate, getHistory, recordHistory } from "./history";
import {
  getChatLang,
  humanizeStatus,
  isLang,
  LANGUAGE_NAMES,
  localizeStock,
  SUPPORTED_LANGUAGES,
  t,
  type Lang,
} from "./i18n";
import { answerCallbackQuery, editMessageText, escapeHtml, sendMainMenu, sendMessage, watchLink } from "./telegram";
import type { Env, InlineKeyboardButton, TelegramCallbackQuery, TelegramMessage, WatchRow } from "./types";

const MAX_WATCHES_PER_CHAT = 20;

function formatResponseTime(ms: number, lang: Lang): string {
  const unit = ms >= 1000 ? (lang === "en" ? "s" : "с") : lang === "en" ? "ms" : "мс";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} ${unit}` : `${ms} ${unit}`;
}

function formatPageSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${bytes} B`;
}

// Facts about the site itself (not any product on it) — response time and
// page size are available for every watch; platform/hosting/security
// headers only for a plain (no-selector) page fetch.
function buildSiteInfoLines(
  w: Pick<WatchRow, "last_response_ms" | "last_page_size" | "last_platform" | "last_hosting" | "last_security_headers">,
  lang: Lang
): string[] {
  const lines: string[] = [];
  if (w.last_response_ms !== null) lines.push(t(lang, "responseTime", { time: formatResponseTime(w.last_response_ms, lang) }));
  if (w.last_page_size !== null) lines.push(t(lang, "pageSize", { size: formatPageSize(w.last_page_size) }));
  if (w.last_platform) lines.push(t(lang, "platform", { platform: escapeHtml(w.last_platform) }));
  if (w.last_hosting) lines.push(t(lang, "hosting", { hosting: escapeHtml(w.last_hosting) }));
  if (w.last_security_headers) lines.push(t(lang, "securityHeaders", { headers: escapeHtml(w.last_security_headers) }));
  return lines;
}

const LANGUAGE_FLAGS: Record<Lang, string> = { uk: "🇺🇦", ru: "🇷🇺", en: "🇬🇧" };

function languageKeyboard(): InlineKeyboardButton[][] {
  return [
    SUPPORTED_LANGUAGES.map((code) => ({
      text: `${LANGUAGE_FLAGS[code]} ${LANGUAGE_NAMES[code]}`,
      callback_data: `lang:${code}`,
    })),
  ];
}

function currencyKeyboard(): InlineKeyboardButton[][] {
  return [SUPPORTED_CURRENCIES.map((code) => ({ text: code, callback_data: `curr:${code}` }))];
}

function menuLabels(lang: Lang): { mySites: string; addSite: string; help: string } {
  return { mySites: t(lang, "menuMySites"), addSite: t(lang, "menuAddSite"), help: t(lang, "menuHelp") };
}

// A user's persistent reply-keyboard buttons keep showing whatever language
// was active when /start (or a language switch) last rendered them — so a
// plain-text match has to recognize the label in *any* supported language,
// not just the chat's current one.
const MENU_LABEL_ACTIONS: Record<string, "list" | "addSite" | "help"> = {};
for (const code of SUPPORTED_LANGUAGES) {
  MENU_LABEL_ACTIONS[t(code, "menuMySites")] = "list";
  MENU_LABEL_ACTIONS[t(code, "menuAddSite")] = "addSite";
  MENU_LABEL_ACTIONS[t(code, "menuHelp")] = "help";
}

// "auto:<rule>:<index>" is an internal addressing scheme from the candidate
// picker, meaningless to a user — only show a selector back when they typed
// it themselves.
function describeSelector(selector: string | null, lang: Lang): string | null {
  if (!selector || selector.startsWith("auto:")) return null;
  return t(lang, "elementLabel", { selector: `<code>${escapeHtml(selector)}</code>` });
}

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
  lang: Lang,
  opts: { back?: boolean } = {}
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    [
      { text: t(lang, "btnCheck"), callback_data: `chk:${w.id}` },
      w.paused
        ? { text: t(lang, "btnResume"), callback_data: `res:${w.id}` }
        : { text: t(lang, "btnPause"), callback_data: `pau:${w.id}` },
    ],
    [{ text: t(lang, "btnDelete"), callback_data: `unw:${w.id}` }],
  ];
  if (w.price && !w.priceTrusted) {
    rows.push([{ text: t(lang, "btnWrongPrice"), callback_data: `fix:${w.id}` }]);
  }
  if (opts.back) {
    rows.push([{ text: t(lang, "btnBack"), callback_data: "back" }]);
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
  const lang = await getChatLang(env, chatId);
  const parsed = parseWatchArgs(arg);
  if (!parsed) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "watchUsage"));
    return;
  }
  const { url, selector } = parsed;

  const existing = await env.DB.prepare(
    "SELECT id FROM watches WHERE chat_id = ? AND url = ? AND active = 1 AND COALESCE(selector, '') = COALESCE(?, '')"
  )
    .bind(chatId, url, selector)
    .first<{ id: number }>();
  if (existing) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "alreadyWatching", { id: existing.id }));
    return;
  }

  const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM watches WHERE chat_id = ? AND active = 1")
    .bind(chatId)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= MAX_WATCHES_PER_CHAT) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "limitReached", { max: MAX_WATCHES_PER_CHAT }));
    return;
  }

  const baseline = await analyzeUrl(env, url, selector);
  const inserted = await env.DB.prepare(
    `INSERT INTO watches (chat_id, url, label, selector, last_status, last_hash, last_price, price_trusted, last_stock, last_seller, last_value, last_content, last_response_ms, last_page_size, last_platform, last_hosting, last_security_headers, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`
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
      baseline.seller,
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

  const lines = [t(lang, "watchAdded", { link: `<b>${watchLink(url, baseline.title)}</b>`, id: inserted?.id ?? "" })];
  const selectorLine = describeSelector(selector, lang);
  if (selectorLine) lines.push(selectorLine);
  if (baseline.error) {
    lines.push(`⚠️ ${escapeHtml(baseline.error)}`);
  } else {
    lines.push(t(lang, "statusLabel", { status: humanizeStatus(baseline.status, lang) }));
    if (baseline.price) {
      const currency = await getChatCurrency(env, chatId);
      const priceDisplay = await convertPrice(env, baseline.price, currency);
      lines.push(t(lang, "priceLabel", { price: escapeHtml(priceDisplay ?? baseline.price) }));
    }
    const stockDisplay = localizeStock(baseline.stock, lang);
    if (stockDisplay) lines.push(t(lang, "stockLabel", { stock: escapeHtml(stockDisplay) }));
    if (baseline.seller) lines.push(t(lang, "sellerLabel", { seller: escapeHtml(baseline.seller) }));
    if (!baseline.price && !baseline.stock && baseline.value) {
      lines.push(t(lang, "valueLabel", { value: escapeHtml(baseline.value) }));
    }
    const siteInfo = buildSiteInfoLines(
      {
        last_response_ms: baseline.responseMs,
        last_page_size: baseline.pageSizeBytes,
        last_platform: baseline.platform,
        last_hosting: baseline.hosting,
        last_security_headers: baseline.securityHeaders,
      },
      lang
    );
    if (siteInfo.length) lines.push("", t(lang, "techInfoHeader"), ...siteInfo);
  }
  const keyboard = inserted
    ? actionRows({ id: inserted.id, price: baseline.price, priceTrusted: baseline.priceTrusted, paused: false }, lang)
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
  chatId: number,
  lang: Lang
): Promise<{ text: string; keyboard: InlineKeyboardButton[][] }> {
  const { results } = await env.DB.prepare(
    "SELECT id, url, label, selector, last_status, last_price, price_trusted, last_stock, last_value, paused FROM watches WHERE chat_id = ? AND active = 1 ORDER BY id"
  )
    .bind(chatId)
    .all<ListRow>();

  if (!results.length) {
    return { text: t(lang, "emptyList"), keyboard: [] };
  }

  const currency = await getChatCurrency(env, chatId);
  const lines = await Promise.all(
    results.map(async (w) => {
      const parts = [`#${w.id} ${watchLink(w.url, w.label)}`];
      if (w.paused) parts.push(t(lang, "pausedBadge"));
      else parts.push(humanizeStatus(w.last_status, lang));
      const priceDisplay = await convertPrice(env, w.last_price, currency);
      if (priceDisplay) parts.push(escapeHtml(priceDisplay));
      const stockDisplay = localizeStock(w.last_stock, lang);
      if (stockDisplay) parts.push(escapeHtml(stockDisplay));
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
  const lang = await getChatLang(env, chatId);
  const { text, keyboard } = await buildListView(env, chatId, lang);
  await sendMessage(env.BOT_TOKEN, chatId, text, keyboard.length ? keyboard : undefined);
}

// The single-watch "management card" a "⚙️ #id" button opens — full detail,
// full action set, and a way back to the overview. Reused after any action
// taken from the card (check/pause/resume) so the card refreshes in place.
async function buildDetailView(
  env: Env,
  chatId: number,
  id: number,
  lang: Lang
): Promise<{ text: string; keyboard: InlineKeyboardButton[][] } | null> {
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) return null;

  const lines = [`<b>${watchLink(watch.url, watch.label)}</b> (id ${watch.id})`];
  if (watch.paused) lines.push(t(lang, "pausedNote"));
  const selectorLine = describeSelector(watch.selector, lang);
  if (selectorLine) lines.push(selectorLine);
  lines.push(t(lang, "statusLabel", { status: humanizeStatus(watch.last_status, lang) }));
  const currency = await getChatCurrency(env, chatId);
  const priceDisplay = await convertPrice(env, watch.last_price, currency);
  if (priceDisplay) lines.push(t(lang, "priceLabel", { price: escapeHtml(priceDisplay) }));
  const stockDisplay = localizeStock(watch.last_stock, lang);
  if (stockDisplay) lines.push(t(lang, "stockLabel", { stock: escapeHtml(stockDisplay) }));
  if (watch.last_seller) lines.push(t(lang, "sellerLabel", { seller: escapeHtml(watch.last_seller) }));
  if (!watch.last_price && !watch.last_stock && watch.last_value) {
    lines.push(t(lang, "valueLabel", { value: escapeHtml(watch.last_value) }));
  }
  const siteInfo = buildSiteInfoLines(watch, lang);
  if (siteInfo.length) lines.push("", t(lang, "techInfoHeader"), ...siteInfo);

  return {
    text: lines.join("\n"),
    keyboard: actionRows(
      { id: watch.id, price: watch.last_price, priceTrusted: Boolean(watch.price_trusted), paused: Boolean(watch.paused) },
      lang,
      { back: true }
    ),
  };
}

async function handleUnwatch(env: Env, chatId: number, arg: string): Promise<void> {
  const lang = await getChatLang(env, chatId);
  const id = Number(arg.trim());
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "idUsage", { example: "/unwatch 3" }));
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
    changed > 0 ? t(lang, "unwatchDone", { id }) : t(lang, "notFoundActive", { id })
  );
}

async function handleRename(env: Env, chatId: number, arg: string): Promise<void> {
  const lang = await getChatLang(env, chatId);
  const parsed = parseIdAndText(arg);
  if (!parsed) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "renameUsage"));
    return;
  }
  const result = await env.DB.prepare("UPDATE watches SET label = ? WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(parsed.text, parsed.id, chatId)
    .run();
  const changed = result.meta.changes ?? 0;
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    changed > 0
      ? t(lang, "renameDone", { id: parsed.id, name: parsed.text })
      : t(lang, "notFoundActive", { id: parsed.id })
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
  const lang = await getChatLang(env, chatId);
  const id = Number(arg.trim());
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "idUsage", { example: paused ? "/pause 3" : "/resume 3" }));
    return;
  }
  const changed = await setPaused(env, chatId, id, paused);
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    changed ? t(lang, paused ? "pausedDone" : "resumedDone", { id }) : t(lang, "notFoundActive", { id })
  );
}

async function handleHistory(env: Env, chatId: number, arg: string): Promise<void> {
  const lang = await getChatLang(env, chatId);
  const id = Number(arg.trim());
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "idUsage", { example: "/history 3" }));
    return;
  }
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ?")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "notFoundAny", { id }));
    return;
  }

  const entries = await getHistory(env, id);
  if (!entries.length) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "historyEmpty"));
    return;
  }

  const currency = await getChatCurrency(env, chatId);
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const parts = [formatHistoryDate(entry.checked_at)];
      const priceDisplay = await convertPrice(env, entry.price, currency);
      if (priceDisplay) parts.push(escapeHtml(priceDisplay));
      const stockDisplay = localizeStock(entry.stock, lang);
      if (stockDisplay) parts.push(escapeHtml(stockDisplay));
      return parts.join(" — ");
    })
  );

  await sendMessage(env.BOT_TOKEN, chatId, `<b>${watchLink(watch.url, watch.label)}</b>\n\n${lines.join("\n")}`);
}

async function runCheck(
  env: Env,
  chatId: number,
  id: number,
  lang: Lang
): Promise<{ text: string; watch: WatchRow } | null> {
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) return null;

  const result = await analyzeUrl(env, watch.url, watch.selector);
  if (result.error) {
    await env.DB.prepare(
      `UPDATE watches SET
         last_error = ?,
         last_checked_at = datetime('now')
       WHERE id = ?`
    )
      .bind(result.error, id)
      .run();
    const lines = [`<b>${watchLink(watch.url, watch.label ?? result.title)}</b>`];
    const selectorLine = describeSelector(watch.selector, lang);
    if (selectorLine) lines.push(selectorLine);
    lines.push(`⚠️ ${escapeHtml(result.error)}`);
    return { text: lines.join("\n"), watch };
  }

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
       last_seller = COALESCE(?, last_seller),
       last_value = COALESCE(?, last_value),
       last_content = COALESCE(?, last_content),
       last_response_ms = COALESCE(?, last_response_ms),
       last_page_size = COALESCE(?, last_page_size),
       last_platform = COALESCE(?, last_platform),
       last_hosting = COALESCE(?, last_hosting),
       last_security_headers = COALESCE(?, last_security_headers),
       consecutive_failures = 0,
       last_error = NULL,
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
      result.seller,
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
  const selectorLine = describeSelector(watch.selector, lang);
  if (selectorLine) lines.push(selectorLine);
  if (result.error) {
    lines.push(`⚠️ ${escapeHtml(result.error)}`);
  } else {
    lines.push(t(lang, "statusLabel", { status: humanizeStatus(result.status, lang) }));
    if (result.price) {
      const currency = await getChatCurrency(env, chatId);
      const priceDisplay = await convertPrice(env, result.price, currency);
      lines.push(t(lang, "priceLabel", { price: escapeHtml(priceDisplay ?? result.price) }));
    }
    const stockDisplay = localizeStock(result.stock, lang);
    if (stockDisplay) lines.push(t(lang, "stockLabel", { stock: escapeHtml(stockDisplay) }));
    if (result.seller) lines.push(t(lang, "sellerLabel", { seller: escapeHtml(result.seller) }));
    if (!result.price && !result.stock && result.value) {
      lines.push(t(lang, "valueLabel", { value: escapeHtml(result.value) }));
    }
    const siteInfo = buildSiteInfoLines(
      {
        last_response_ms: result.responseMs,
        last_page_size: result.pageSizeBytes,
        last_platform: result.platform,
        last_hosting: result.hosting,
        last_security_headers: result.securityHeaders,
      },
      lang
    );
    if (siteInfo.length) lines.push("", t(lang, "techInfoHeader"), ...siteInfo);
  }
  return { text: lines.join("\n"), watch };
}

async function handleCheck(env: Env, chatId: number, arg: string): Promise<void> {
  const lang = await getChatLang(env, chatId);
  const id = Number(arg.trim());
  if (!Number.isInteger(id)) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "idUsage", { example: "/check 3" }));
    return;
  }
  const outcome = await runCheck(env, chatId, id, lang);
  if (!outcome) {
    await sendMessage(env.BOT_TOKEN, chatId, t(lang, "notFoundActive", { id }));
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
    const menuAction = MENU_LABEL_ACTIONS[text];
    if (menuAction === "list") return handleList(env, chatId);
    if (menuAction === "help") {
      const lang = await getChatLang(env, chatId);
      await sendMessage(env.BOT_TOKEN, chatId, t(lang, "help"));
      return;
    }
    if (menuAction === "addSite") {
      const lang = await getChatLang(env, chatId);
      await sendMessage(env.BOT_TOKEN, chatId, t(lang, "addSitePrompt"));
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
      const storedLangRaw = await env.DB.prepare("SELECT language FROM chat_settings WHERE chat_id = ?")
        .bind(chatId)
        .first<{ language: string | null }>();
      const lang = await getChatLang(env, chatId);
      await sendMainMenu(env.BOT_TOKEN, chatId, t(lang, "welcome"), menuLabels(lang));
      if (!storedLangRaw?.language) {
        await sendMessage(env.BOT_TOKEN, chatId, t(lang, "askLanguage"), languageKeyboard());
      } else {
        const currency = await getChatCurrency(env, chatId);
        if (!currency) await sendMessage(env.BOT_TOKEN, chatId, t(lang, "askCurrency"), currencyKeyboard());
      }
      break;
    }
    case "/help": {
      const lang = await getChatLang(env, chatId);
      await sendMessage(env.BOT_TOKEN, chatId, t(lang, "help"));
      break;
    }
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
    case "/currency": {
      const lang = await getChatLang(env, chatId);
      await sendMessage(env.BOT_TOKEN, chatId, t(lang, "askCurrency"), currencyKeyboard());
      break;
    }
    case "/language": {
      const lang = await getChatLang(env, chatId);
      await sendMessage(env.BOT_TOKEN, chatId, t(lang, "askLanguage"), languageKeyboard());
      break;
    }
    default: {
      const lang = await getChatLang(env, chatId);
      await sendMessage(env.BOT_TOKEN, chatId, t(lang, "unknownCommand"));
    }
  }
}

async function handleFixButton(env: Env, chatId: number, queryId: string, id: number, lang: Lang): Promise<void> {
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) {
    await answerCallbackQuery(env.BOT_TOKEN, queryId, t(lang, "toastNotFound"));
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
    await answerCallbackQuery(env.BOT_TOKEN, queryId, t(lang, "fixNoCandidates"));
    return;
  }

  await answerCallbackQuery(env.BOT_TOKEN, queryId);
  const rows = candidates.map((c) => [
    { text: `💰 ${c.value}`, callback_data: `pick:${id}:${c.ruleId}:${c.index}` },
  ]);
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    t(lang, "fixPrompt", { link: `<b>${watchLink(watch.url, watch.label)}</b>` }),
    rows
  );
}

async function handlePickCandidate(
  env: Env,
  chatId: number,
  queryId: string,
  id: number,
  ruleId: string,
  indexRaw: string,
  lang: Lang
): Promise<void> {
  const selector = `auto:${ruleId}:${indexRaw}`;
  const result = await env.DB.prepare(
    "UPDATE watches SET selector = ? WHERE id = ? AND chat_id = ? AND active = 1"
  )
    .bind(selector, id, chatId)
    .run();
  if (!(result.meta.changes ?? 0)) {
    await answerCallbackQuery(env.BOT_TOKEN, queryId, t(lang, "toastNotFound"));
    return;
  }

  const outcome = await runCheck(env, chatId, id, lang);
  await answerCallbackQuery(env.BOT_TOKEN, queryId, t(lang, "toastSaved"));
  if (outcome) await sendMessage(env.BOT_TOKEN, chatId, outcome.text);
}

export async function handleCallbackQuery(env: Env, query: TelegramCallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data ?? "";
  const [action, idRaw, ...rest] = data.split(":");

  if (!chatId) {
    await answerCallbackQuery(env.BOT_TOKEN, query.id, "…");
    return;
  }

  const lang = await getChatLang(env, chatId);

  if (action === "curr") {
    await setChatCurrency(env, chatId, idRaw);
    await answerCallbackQuery(env.BOT_TOKEN, query.id, t(lang, "currencySet", { code: idRaw }));
    return;
  }

  if (action === "lang") {
    if (isLang(idRaw)) {
      await setChatLanguage(env, chatId, idRaw);
      await answerCallbackQuery(env.BOT_TOKEN, query.id, t(idRaw, "languageSet", { name: LANGUAGE_NAMES[idRaw] }));
      // Refresh the persistent menu keyboard in the new language, then chain
      // into the currency step if it hasn't been picked yet — same two-step
      // onboarding as a fresh /start.
      await sendMainMenu(env.BOT_TOKEN, chatId, t(idRaw, "welcome"), menuLabels(idRaw));
      const currency = await getChatCurrency(env, chatId);
      if (!currency) await sendMessage(env.BOT_TOKEN, chatId, t(idRaw, "askCurrency"), currencyKeyboard());
    }
    return;
  }

  if (action === "back") {
    if (messageId) {
      const { text, keyboard } = await buildListView(env, chatId, lang);
      await editMessageText(env.BOT_TOKEN, chatId, messageId, text, keyboard);
    }
    await answerCallbackQuery(env.BOT_TOKEN, query.id);
    return;
  }

  const id = Number(idRaw);
  if (!messageId || !Number.isInteger(id)) {
    await answerCallbackQuery(env.BOT_TOKEN, query.id, t(lang, "toastStaleButtonRefresh"));
    return;
  }

  if (action === "mgr") {
    const detail = await buildDetailView(env, chatId, id, lang);
    await answerCallbackQuery(env.BOT_TOKEN, query.id, detail ? undefined : t(lang, "toastNotFound"));
    if (detail) await editMessageText(env.BOT_TOKEN, chatId, messageId, detail.text, detail.keyboard);
    return;
  }

  if (action === "chk") {
    const outcome = await runCheck(env, chatId, id, lang);
    await answerCallbackQuery(env.BOT_TOKEN, query.id, outcome ? t(lang, "toastChecked") : t(lang, "toastNotFound"));
    if (outcome) {
      const detail = await buildDetailView(env, chatId, id, lang);
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
    await answerCallbackQuery(env.BOT_TOKEN, query.id, changed > 0 ? t(lang, "toastRemoved") : t(lang, "toastNotFound"));
    if (changed > 0) {
      const { text, keyboard } = await buildListView(env, chatId, lang);
      await editMessageText(env.BOT_TOKEN, chatId, messageId, text, keyboard);
    }
    return;
  }

  if (action === "pau" || action === "res") {
    const changed = await setPaused(env, chatId, id, action === "pau");
    await answerCallbackQuery(
      env.BOT_TOKEN,
      query.id,
      changed ? t(lang, action === "pau" ? "toastPaused" : "toastResumed") : t(lang, "toastNotFound")
    );
    if (changed) {
      const detail = await buildDetailView(env, chatId, id, lang);
      if (detail) await editMessageText(env.BOT_TOKEN, chatId, messageId, detail.text, detail.keyboard);
    }
    return;
  }

  if (action === "fix") {
    await handleFixButton(env, chatId, query.id, id, lang);
    return;
  }

  if (action === "pick") {
    const [ruleId, indexRaw] = rest;
    if (ruleId && indexRaw) {
      await handlePickCandidate(env, chatId, query.id, id, ruleId, indexRaw, lang);
      return;
    }
  }

  await answerCallbackQuery(env.BOT_TOKEN, query.id);
}
