import Anthropic from "@anthropic-ai/sdk";
import type { Lang } from "./i18n";
import type { Env } from "./types";

const PROMPT_LANGUAGE_NAME: Record<Lang, string> = {
  uk: "Ukrainian",
  ru: "Russian",
  en: "English",
};

const NO_CHANGE_TEXT: Record<Lang, string> = {
  uk: "Не вдалося точно визначити, що саме змінилося.",
  ru: "Не удалось точно определить, что именно изменилось.",
  en: "Could not pin down exactly what changed.",
};

function buildSystemPrompt(lang: Lang): string {
  return (
    `You analyze changes to a web page for a monitoring bot. Compare the old and new text snapshots of the same ` +
    `page and write 1-2 sentences in ${PROMPT_LANGUAGE_NAME[lang]} about what meaningfully changed. Ignore minor ` +
    `technical noise (whitespace, incidental numbers like view counters or dates). If you can't see a meaningful ` +
    `difference, reply with exactly: "${NO_CHANGE_TEXT[lang]}". Reply with only the summary itself, no preamble or heading.`
  );
}

// Only called for watches that have never shown a price/stock (a plain
// "watch this page" case) — commerce pages already get a precise price/
// stock/status diff from code, no AI needed there. Returns null (falls back
// to the plain "content changed" line) when no key is configured or the call
// fails for any reason — this is a nice-to-have, never a blocker.
export async function summarizeChange(env: Env, prevText: string, nextText: string, lang: Lang): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 300,
      output_config: { effort: "low" },
      system: buildSystemPrompt(lang),
      messages: [
        {
          role: "user",
          content: `OLD TEXT:\n${prevText}\n\nNEW TEXT:\n${nextText}`,
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
