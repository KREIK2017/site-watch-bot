import { handleCallbackQuery, handleMessage } from "./commands";
import { runAllChecks } from "./monitor";
import type { Env, TelegramUpdate } from "./types";

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
      if (update.message) {
        ctx.waitUntil(handleMessage(env, update.message));
      } else if (update.callback_query) {
        ctx.waitUntil(handleCallbackQuery(env, update.callback_query));
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAllChecks(env));
  },
};
