import { analyzeUrl } from "./checker";
import { escapeHtml, sendMessage } from "./telegram";
import type { AnalyzeResult, Env, WatchRow } from "./types";

const CONCURRENCY = 8;

function buildChanges(prev: WatchRow, next: AnalyzeResult): string[] {
  const changes: string[] = [];

  if (prev.last_status !== null && next.status !== null && prev.last_status !== next.status) {
    changes.push(`• Status: ${prev.last_status} → ${next.status}`);
  }
  if (prev.last_price && next.price && prev.last_price !== next.price) {
    changes.push(`• Price: ${escapeHtml(prev.last_price)} → ${escapeHtml(next.price)}`);
  }
  if (prev.last_stock && next.stock && prev.last_stock !== next.stock) {
    changes.push(`• Stock: ${escapeHtml(prev.last_stock)} → ${escapeHtml(next.stock)}`);
  }
  // Only flag a generic content change when nothing more specific changed,
  // otherwise every price/stock update would also print a redundant line.
  if (
    changes.length === 0 &&
    prev.last_hash &&
    next.textHash &&
    prev.last_hash !== next.textHash
  ) {
    changes.push("• Page content changed");
  }

  return changes;
}

async function checkOne(env: Env, watch: WatchRow): Promise<void> {
  const result = await analyzeUrl(watch.url);

  if (result.error) {
    // Only alert on the transition into an error state, not on every failed retry.
    if (watch.last_status !== null) {
      await sendMessage(
        env.BOT_TOKEN,
        watch.chat_id,
        `🚨 <b>${escapeHtml(watch.url)}</b> is unreachable\n${escapeHtml(result.error)}`
      );
    }
    await env.DB.prepare(
      "UPDATE watches SET last_status = NULL, last_checked_at = datetime('now') WHERE id = ?"
    )
      .bind(watch.id)
      .run();
    return;
  }

  const changes = buildChanges(watch, result);
  // A brand-new watch (no baseline yet) just gets its baseline stored, no alert.
  if (changes.length > 0 && watch.last_hash !== null) {
    const host = new URL(watch.url).hostname;
    const text = [`🚨 <b>WEBSITE CHANGED</b>`, host, "", "Changed:", ...changes].join("\n");
    await sendMessage(env.BOT_TOKEN, watch.chat_id, text);
  }

  await env.DB.prepare(
    `UPDATE watches SET last_status = ?, last_hash = ?, last_price = ?, last_stock = ?, last_checked_at = datetime('now')
     WHERE id = ?`
  )
    .bind(result.status, result.textHash, result.price, result.stock, watch.id)
    .run();
}

export async function runAllChecks(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM watches WHERE active = 1").all<WatchRow>();

  for (let i = 0; i < results.length; i += CONCURRENCY) {
    const batch = results.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((watch) =>
        checkOne(env, watch).catch((err) => console.error(`check failed for watch ${watch.id}`, err))
      )
    );
  }
}
