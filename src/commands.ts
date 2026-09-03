import { analyzeUrl, humanizeStatus } from "./checker";
import { answerCallbackQuery, editMessageText, escapeHtml, sendMessage } from "./telegram";
import type { Env, InlineKeyboardButton, TelegramCallbackQuery, TelegramMessage, WatchRow } from "./types";

const HELP_TEXT = `<b>Site Watch Bot</b>
Слідкую за сайтами і повідомляю про зміни ціни, наявності, статусу сторінки чи вмісту.

<b>Команди:</b>
/watch &lt;url&gt; — стежити за всією сторінкою
/watch &lt;url&gt; &lt;css-селектор&gt; — стежити тільки за одним товаром/блоком
/list — список сайтів, за якими стежу (з кнопками)
/check &lt;id&gt; — перевірити зараз
/unwatch &lt;id&gt; — прибрати зі списку
/help — ця довідка

<b>Приклад для товару:</b>
<code>/watch https://shop.com/product .price</code>
Як знайти селектор: відкрий сторінку в браузері → правий клік на ціні/кнопці "Купити" → "Inspect" (Переглянути код) → правий клік на підсвіченому рядку в панелі розробника → Copy → Copy selector.

Якщо ціна на сайті малюється через JavaScript (у сирому HTML її просто немає), можна витягти число напряму з атрибута елемента:
<code>/watch https://shop.com/product .price @data-price</code>`;

function watchButtonsRow(id: number): InlineKeyboardButton[] {
  return [
    { text: `🔄 Перевірити #${id}`, callback_data: `chk:${id}` },
    { text: `🗑 Прибрати #${id}`, callback_data: `unw:${id}` },
  ];
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

  const baseline = await analyzeUrl(url, selector);
  const inserted = await env.DB.prepare(
    `INSERT INTO watches (chat_id, url, selector, last_status, last_hash, last_price, last_stock, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`
  )
    .bind(chatId, url, selector, baseline.status, baseline.textHash, baseline.price, baseline.stock)
    .first<{ id: number }>();

  const lines = [`✅ Стежу за <b>${escapeHtml(url)}</b> (id ${inserted?.id})`];
  if (selector) lines.push(`Елемент: <code>${escapeHtml(selector)}</code>`);
  if (baseline.error) {
    lines.push(`⚠️ ${escapeHtml(baseline.error)}`);
  } else {
    lines.push(`Статус: ${humanizeStatus(baseline.status)}`);
    if (baseline.price) lines.push(`Ціна: ${escapeHtml(baseline.price)}`);
    if (baseline.stock) lines.push(`Наявність: ${escapeHtml(baseline.stock)}`);
  }
  const keyboard = inserted ? [watchButtonsRow(inserted.id)] : undefined;
  await sendMessage(env.BOT_TOKEN, chatId, lines.join("\n"), keyboard);
}

type ListRow = Pick<WatchRow, "id" | "url" | "selector" | "last_status" | "last_price" | "last_stock">;

async function buildListView(
  env: Env,
  chatId: number
): Promise<{ text: string; keyboard: InlineKeyboardButton[][] }> {
  const { results } = await env.DB.prepare(
    "SELECT id, url, selector, last_status, last_price, last_stock FROM watches WHERE chat_id = ? AND active = 1 ORDER BY id"
  )
    .bind(chatId)
    .all<ListRow>();

  if (!results.length) {
    return { text: "Список порожній. Додай сайт: <code>/watch https://example.com</code>", keyboard: [] };
  }

  const lines = results.map((w) => {
    const parts = [`#${w.id} ${escapeHtml(w.url)}`, humanizeStatus(w.last_status)];
    if (w.last_price) parts.push(`ціна ${escapeHtml(w.last_price)}`);
    if (w.last_stock) parts.push(escapeHtml(w.last_stock));
    if (w.selector) parts.push(`[${escapeHtml(w.selector)}]`);
    return parts.join(" — ");
  });

  return { text: lines.join("\n"), keyboard: results.map((w) => watchButtonsRow(w.id)) };
}

async function handleList(env: Env, chatId: number): Promise<void> {
  const { text, keyboard } = await buildListView(env, chatId);
  await sendMessage(env.BOT_TOKEN, chatId, text, keyboard.length ? keyboard : undefined);
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

async function runCheck(env: Env, chatId: number, id: number): Promise<{ text: string; watch: WatchRow } | null> {
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND chat_id = ? AND active = 1")
    .bind(id, chatId)
    .first<WatchRow>();
  if (!watch) return null;

  const result = await analyzeUrl(watch.url, watch.selector);
  await env.DB.prepare(
    `UPDATE watches SET last_status = ?, last_hash = ?, last_price = ?, last_stock = ?, last_checked_at = datetime('now')
     WHERE id = ?`
  )
    .bind(result.status, result.textHash, result.price, result.stock, id)
    .run();

  const lines = [`<b>${escapeHtml(watch.url)}</b>`];
  if (watch.selector) lines.push(`Елемент: <code>${escapeHtml(watch.selector)}</code>`);
  if (result.error) {
    lines.push(`⚠️ ${escapeHtml(result.error)}`);
  } else {
    lines.push(`Статус: ${humanizeStatus(result.status)}`);
    if (result.price) lines.push(`Ціна: ${escapeHtml(result.price)}`);
    if (result.stock) lines.push(`Наявність: ${escapeHtml(result.stock)}`);
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

export async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  if (!text.startsWith("/")) return;

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const arg = rest.join(" ");

  switch (command) {
    case "/start":
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
    default:
      await sendMessage(env.BOT_TOKEN, chatId, "Не знаю такої команди. /help — список команд.");
  }
}

export async function handleCallbackQuery(env: Env, query: TelegramCallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data ?? "";
  const [action, idRaw] = data.split(":");
  const id = Number(idRaw);

  if (!chatId || !messageId || !Number.isInteger(id)) {
    await answerCallbackQuery(env.BOT_TOKEN, query.id, "Кнопка застаріла, онови список через /list");
    return;
  }

  if (action === "chk") {
    const outcome = await runCheck(env, chatId, id);
    await answerCallbackQuery(env.BOT_TOKEN, query.id, outcome ? "Перевірено ✅" : "Не знайдено");
    if (outcome) await sendMessage(env.BOT_TOKEN, chatId, outcome.text);
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

  await answerCallbackQuery(env.BOT_TOKEN, query.id);
}
