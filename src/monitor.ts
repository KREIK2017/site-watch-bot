import { analyzeUrl, humanizeStatus } from "./checker";
import { convertPrice, getChatCurrency } from "./currency";
import { escapeHtml, sendMessage, watchLink } from "./telegram";
import type { AnalyzeResult, Env, WatchRow } from "./types";

const CONCURRENCY = 8;

function isGoodStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

async function buildChanges(
  env: Env,
  currency: string | null,
  prev: WatchRow,
  next: AnalyzeResult
): Promise<string[]> {
  const changes: string[] = [];

  if (prev.last_status !== null && next.status !== null && prev.last_status !== next.status) {
    changes.push(`• Статус: ${humanizeStatus(prev.last_status)} → ${humanizeStatus(next.status)}`);
  }
  if (prev.last_price && next.price && prev.last_price !== next.price) {
    const [prevDisplay, nextDisplay] = await Promise.all([
      convertPrice(env, prev.last_price, currency),
      convertPrice(env, next.price, currency),
    ]);
    changes.push(`• Ціна: ${escapeHtml(prevDisplay ?? prev.last_price)} → ${escapeHtml(nextDisplay ?? next.price)}`);
  }
  if (prev.last_stock && next.stock && prev.last_stock !== next.stock) {
    changes.push(`• Наявність: ${escapeHtml(prev.last_stock)} → ${escapeHtml(next.stock)}`);
  }
  // For a selector watch with no price/stock shape (a manga chapter number, a
  // forum reply count, a score...), show the actual old → new value instead
  // of falling back to a vague "content changed".
  if (
    changes.length === 0 &&
    !next.price &&
    !next.stock &&
    prev.last_value &&
    next.value &&
    prev.last_value !== next.value
  ) {
    changes.push(`• Значення: ${escapeHtml(prev.last_value)} → ${escapeHtml(next.value)}`);
  }
  // Only flag a generic whole-page content change on watches that have never
  // shown a price/stock at all (a plain "watch this page" case). Once a page
  // is known to be a commerce page, its full-text hash is too noisy to alert
  // on directly — ads, "recently viewed", view counters and the like change
  // on their own, and a site that intermittently returns an anti-bot
  // challenge page instead of the real one would otherwise look like its
  // content keeps "changing" every time it flips between the two.
  const isCommercePage = prev.last_price || next.price || prev.last_stock || next.stock;
  if (
    changes.length === 0 &&
    !isCommercePage &&
    prev.last_hash &&
    next.textHash &&
    prev.last_hash !== next.textHash
  ) {
    changes.push("• Вміст сторінки змінився");
  }

  return changes;
}

async function checkOne(env: Env, watch: WatchRow): Promise<void> {
  const result = await analyzeUrl(env, watch.url, watch.selector);

  if (result.error) {
    // Only alert on the transition into an error state, not on every failed retry.
    if (watch.last_status !== null) {
      await sendMessage(
        env.BOT_TOKEN,
        watch.chat_id,
        `🚨 <b>${watchLink(watch.url, watch.label)}</b>\nПроблема при перевірці: ${escapeHtml(result.error)}`
      );
    }
    await env.DB.prepare(
      "UPDATE watches SET last_status = NULL, last_checked_at = datetime('now') WHERE id = ?"
    )
      .bind(watch.id)
      .run();
    return;
  }

  // Debounce status flips into a *bad* state: a plain 4xx/5xx response isn't
  // a thrown error, so it flows through here rather than the branch above.
  // A site that only sometimes serves an anti-bot challenge page would
  // otherwise report "went down" and "recovered" on every single cron tick.
  // Recovery (bad → good) is always reported immediately; going bad only
  // commits once the same status is seen on two consecutive checks.
  let effectiveStatus = result.status;
  let newPendingStatus: number | null = null;
  if (watch.last_status !== null && result.status !== watch.last_status) {
    if (isGoodStatus(result.status) || !isGoodStatus(watch.last_status)) {
      effectiveStatus = result.status;
    } else if (watch.pending_status === result.status) {
      effectiveStatus = result.status;
    } else {
      effectiveStatus = watch.last_status;
      newPendingStatus = result.status;
    }
  }

  const currency = await getChatCurrency(env, watch.chat_id);
  const changes = await buildChanges(env, currency, watch, { ...result, status: effectiveStatus });
  // A brand-new watch (no baseline yet) just gets its baseline stored, no alert.
  if (changes.length > 0 && watch.last_hash !== null) {
    const text = [
      `🚨 <b>САЙТ ЗМІНИВСЯ</b>`,
      watchLink(watch.url, watch.label),
      "",
      "Зміни:",
      ...changes,
    ].join("\n");
    await sendMessage(env.BOT_TOKEN, watch.chat_id, text);
  }

  // A blocked/challenged check returns nulls for hash/price/stock; COALESCE
  // keeps the last known-good values instead of wiping them out, so a
  // transient block doesn't erase what we actually know about the page.
  await env.DB.prepare(
    `UPDATE watches SET
       label = COALESCE(?, label),
       last_status = ?,
       pending_status = ?,
       last_hash = COALESCE(?, last_hash),
       last_price = COALESCE(?, last_price),
       price_trusted = CASE WHEN ? IS NOT NULL THEN ? ELSE price_trusted END,
       last_stock = COALESCE(?, last_stock),
       last_value = COALESCE(?, last_value),
       last_checked_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      result.title,
      effectiveStatus,
      newPendingStatus,
      result.textHash,
      result.price,
      result.price,
      result.priceTrusted ? 1 : 0,
      result.stock,
      result.value,
      watch.id
    )
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
