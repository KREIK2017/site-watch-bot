import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./types";

const SYSTEM_PROMPT =
  'Ти аналізуєш зміни на сторінці сайту для бота-монітора. Порівняй старий і новий знімки тексту однієї сторінки та напиши 1-2 речення українською про те, що саме змінилося по суті. Ігноруй дрібні технічні відмінності (пробіли, випадкові числа на кшталт лічильників чи дат). Якщо суттєвої різниці не видно, напиши рівно: «Не вдалося точно визначити, що саме змінилося.» Відповідай тільки самим резюме, без вступних фраз і заголовків.';

// Only called for watches that have never shown a price/stock (a plain
// "watch this page" case) — commerce pages already get a precise price/
// stock/status diff from code, no AI needed there. Returns null (falls back
// to the plain "Вміст сторінки змінився" line) when no key is configured or
// the call fails for any reason — this is a nice-to-have, never a blocker.
export async function summarizeChange(env: Env, prevText: string, nextText: string): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 300,
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `СТАРИЙ ТЕКСТ:\n${prevText}\n\nНОВИЙ ТЕКСТ:\n${nextText}`,
        },
      ],
    });
    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    return textBlock?.text.trim() || null;
  } catch (err) {
    console.error("AI change summary failed", err);
    return null;
  }
}
