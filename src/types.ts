export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  // Optional: powers the AI change-summary feature. Without it, watches just
  // fall back to the plain "Вміст сторінки змінився" line.
  ANTHROPIC_API_KEY?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// Exactly one of callback_data/url per button (Telegram's own constraint).
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface WatchRow {
  id: number;
  chat_id: number;
  url: string;
  label: string | null;
  selector: string | null;
  last_status: number | null;
  pending_status: number | null;
  last_hash: string | null;
  last_price: string | null;
  price_trusted: number;
  last_stock: string | null;
  last_value: string | null;
  last_content: string | null;
  paused: number;
  created_at: string;
  last_checked_at: string | null;
  active: number;
}

export interface AnalyzeResult {
  status: number | null;
  sslOk: boolean;
  title: string | null;
  textHash: string | null;
  value: string | null;
  // Truncated whole-page text, kept only for no-selector watches that have
  // never shown a price/stock — feeds the AI change-summary feature.
  content: string | null;
  price: string | null;
  priceTrusted: boolean;
  stock: string | null;
  error?: string;
}
