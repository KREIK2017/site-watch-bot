export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
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

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface WatchRow {
  id: number;
  chat_id: number;
  url: string;
  label: string | null;
  selector: string | null;
  last_status: number | null;
  last_hash: string | null;
  last_price: string | null;
  last_stock: string | null;
  created_at: string;
  last_checked_at: string | null;
  active: number;
}

export interface AnalyzeResult {
  status: number | null;
  sslOk: boolean;
  title: string | null;
  textHash: string | null;
  price: string | null;
  stock: string | null;
  error?: string;
}
