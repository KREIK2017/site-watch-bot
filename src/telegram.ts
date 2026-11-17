import type { InlineKeyboardButton } from "./types";

async function callTelegram(token: string, method: string, body: unknown): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errorText = await res.text();
    // Repeated taps can legitimately render the same navigation state. Telegram
    // returns 400 for this harmless case, so keep it out of the error stream.
    if (method === "editMessageText" && errorText.includes("message is not modified")) return true;
    console.error(`${method} failed`, res.status, errorText);
    return false;
  }
  return true;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  buttons?: InlineKeyboardButton[][]
): Promise<void> {
  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
  });
}

// A persistent reply keyboard (unlike inline buttons) stays docked under the
// text field across every future message until explicitly replaced, so this
// only needs to be (re-)sent on /start or a language change to act as the
// bot's main menu.
export async function sendMainMenu(
  token: string,
  chatId: number,
  text: string,
  labels: { mySites: string; addSite: string; help: string }
): Promise<void> {
  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      keyboard: [[{ text: labels.mySites }, { text: labels.addSite }], [{ text: labels.help }]],
      resize_keyboard: true,
      is_persistent: true,
    },
  });
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  buttons?: InlineKeyboardButton[][]
): Promise<void> {
  await callTelegram(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons ?? [] },
  });
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await callTelegram(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

export async function setBotCommands(
  token: string,
  commands: Array<{ command: string; description: string }>
): Promise<void> {
  await callTelegram(token, "setMyCommands", { commands });
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/"/g, "&quot;");
}

// Shows the product/page name (falling back to its hostname) as a tappable
// link instead of dumping the raw, often very long, URL into the chat.
export function watchLink(url: string, label: string | null): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // keep the raw url as a last resort
  }
  const displayText = label || host;
  return `<a href="${escapeAttr(url)}">${escapeHtml(displayText)}</a>`;
}
