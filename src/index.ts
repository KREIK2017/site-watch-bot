import { handleCallbackQuery, handleMessage } from "./commands";
import { runAllChecks } from "./monitor";
import type { Env, TelegramUpdate } from "./types";

async function handleUpdateOnce(env: Env, update: TelegramUpdate): Promise<void> {
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)")
    .bind(update.update_id)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return;

  if (update.message) await handleMessage(env, update.message);
  else if (update.callback_query) await handleCallbackQuery(env, update.callback_query);

  // Telegram update IDs only need short-term deduplication. Keep the table
  // bounded without adding another scheduled job.
  await env.DB.prepare("DELETE FROM telegram_updates WHERE received_at < datetime('now', '-7 days')").run();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Site Watch Bot is running", { status: 200 });
    }

    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretHeader !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }

      const update = (await request.json()) as TelegramUpdate;
      ctx.waitUntil(handleUpdateOnce(env, update));
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAllChecks(env));
  },
};
