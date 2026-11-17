import { summarizeChange } from "./ai";
import { analyzeUrl } from "./checker";
import { convertPrice, getChatCurrency } from "./currency";
import { recordHistory } from "./history";
import { getChatLang, humanizeStatus, localizeStock, t, type Lang } from "./i18n";
import { deriveMonitorState, isSuccessfulState, stateFromWatch, type MonitorState } from "./monitoring-state";
import { escapeHtml, sendMessage, watchLink } from "./telegram";
import type { AnalyzeResult, Env, WatchRow } from "./types";

const CONCURRENCY = 8;
const ERROR_ALERT_THRESHOLD = 3;
const BLOCKED_REMINDER_HOURS = 24;

function reminderDue(lastNotifiedAt: string | null, hours: number): boolean {
  if (!lastNotifiedAt) return true;
  const normalized = lastNotifiedAt.includes("T") ? lastNotifiedAt : `${lastNotifiedAt.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isNaN(timestamp) || Date.now() - timestamp >= hours * 60 * 60 * 1000;
}

async function recordStateEvent(
  env: Env,
  watch: WatchRow,
  fromState: MonitorState,
  toState: MonitorState,
  details?: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO monitor_events (watch_id, chat_id, event_type, from_state, to_state, details)
     VALUES (?, ?, 'STATE_CHANGED', ?, ?, ?)`
  )
    .bind(watch.id, watch.chat_id, fromState, toState, details ?? null)
    .run();
}

async function notifyStateTransition(
  env: Env,
  watch: WatchRow,
  lang: Lang,
  fromState: MonitorState,
  toState: MonitorState
): Promise<void> {
  let key: "eventBlocked" | "eventRecovered" | "eventOffline" | "eventUnknown" | null = null;
  if (toState === "BLOCKED") key = "eventBlocked";
  else if (toState === "OFFLINE") key = "eventOffline";
  else if (toState === "UNKNOWN") key = "eventUnknown";
  else if (isSuccessfulState(toState) && !isSuccessfulState(fromState)) key = "eventRecovered";
  if (!key) return;
  await sendMessage(
    env.BOT_TOKEN,
    watch.chat_id,
    t(lang, key, { link: watchLink(watch.url, watch.label) }),
    [[{ text: t(lang, "btnCheck"), callback_data: `chk:${watch.id}` }]]
  );
}

function isGoodStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

async function buildChanges(
  env: Env,
  lang: Lang,
  currency: string | null,
  prev: WatchRow,
  next: AnalyzeResult
): Promise<string[]> {
  const changes: string[] = [];

  if (prev.last_status !== null && next.status !== null && prev.last_status !== next.status) {
    changes.push(
      t(lang, "changeStatus", { from: humanizeStatus(prev.last_status, lang), to: humanizeStatus(next.status, lang) })
    );
  }
  if (prev.last_price && next.price && prev.last_price !== next.price) {
    const [prevDisplay, nextDisplay] = await Promise.all([
      convertPrice(env, prev.last_price, currency),
      convertPrice(env, next.price, currency),
    ]);
    changes.push(
      t(lang, "changePrice", {
        from: escapeHtml(prevDisplay ?? prev.last_price),
        to: escapeHtml(nextDisplay ?? next.price),
      })
    );
  }
  if (prev.last_stock && next.stock && prev.last_stock !== next.stock) {
    changes.push(
      t(lang, "changeStock", {
        from: escapeHtml(localizeStock(prev.last_stock, lang) ?? prev.last_stock),
        to: escapeHtml(localizeStock(next.stock, lang) ?? next.stock),
      })
    );
  }
  if (prev.last_seller && next.seller && prev.last_seller !== next.seller) {
    changes.push(
      t(lang, "changeSeller", {
        from: escapeHtml(prev.last_seller),
        to: escapeHtml(next.seller),
      })
    );
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
    changes.push(t(lang, "changeValue", { from: escapeHtml(prev.last_value), to: escapeHtml(next.value) }));
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
    const summary =
      prev.last_content && next.content ? await summarizeChange(env, prev.last_content, next.content, lang) : null;
    changes.push(summary ? `• ${summary}` : t(lang, "contentChanged"));
  }

  return changes;
}

async function checkOne(env: Env, watch: WatchRow): Promise<void> {
  const lang = await getChatLang(env, watch.chat_id);
  const result = await analyzeUrl(env, watch.url, watch.selector);
  const previousState = stateFromWatch(watch);

  if (result.error) {
    const failureCount = (watch.consecutive_failures ?? 0) + 1;
    const nextState = deriveMonitorState(result);
    const stateChanged = nextState !== previousState;
    const reminder = nextState === "BLOCKED" && reminderDue(watch.last_state_notified_at, BLOCKED_REMINDER_HOURS);
    const shouldNotify =
      nextState === "BLOCKED" ? stateChanged || reminder : failureCount === ERROR_ALERT_THRESHOLD;
    if (shouldNotify) await notifyStateTransition(env, watch, lang, previousState, nextState);
    if (stateChanged) await recordStateEvent(env, watch, previousState, nextState, result.error);
    await env.DB.prepare(
      `UPDATE watches SET
         consecutive_failures = ?,
         last_error = ?,
         monitor_state = ?,
         last_checked_at = datetime('now'),
         last_attempt_at = datetime('now'),
         last_state_notified_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_state_notified_at END
       WHERE id = ?`
    )
      .bind(failureCount, result.error, nextState, shouldNotify ? 1 : 0, watch.id)
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

  const isBaseline = watch.last_hash === null;
  const priceChanged = Boolean(result.price) && result.price !== watch.last_price;
  const stockChanged = Boolean(result.stock) && result.stock !== watch.last_stock;
  const sellerChanged = Boolean(result.seller) && result.seller !== watch.last_seller;
  if (isBaseline || priceChanged || stockChanged || sellerChanged) {
    await recordHistory(
      env,
      watch.id,
      result.price ?? watch.last_price,
      result.stock ?? watch.last_stock,
      effectiveStatus
    );
  }

  const currency = await getChatCurrency(env, watch.chat_id);
  const nextState = deriveMonitorState({ ...result, status: effectiveStatus });
  const changes = await buildChanges(env, lang, currency, watch, { ...result, status: effectiveStatus });
  // A brand-new watch (no baseline yet) just gets its baseline stored, no alert.
  if (changes.length > 0 && watch.last_hash !== null) {
    const text = [t(lang, "alertHeader"), watchLink(watch.url, watch.label), "", t(lang, "changesLabel"), ...changes].join(
      "\n"
    );
    await sendMessage(env.BOT_TOKEN, watch.chat_id, text);
    await env.DB.prepare(
      `INSERT INTO monitor_events (watch_id, chat_id, event_type, from_state, to_state, details)
       VALUES (?, ?, 'CONTENT_CHANGED', ?, ?, ?)`
    )
      .bind(watch.id, watch.chat_id, previousState, nextState, changes.join("\n"))
      .run();
  }

  if (nextState !== previousState) {
    await notifyStateTransition(env, watch, lang, previousState, nextState);
    await recordStateEvent(env, watch, previousState, nextState);
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
       last_seller = COALESCE(?, last_seller),
       last_value = COALESCE(?, last_value),
       last_content = COALESCE(?, last_content),
       last_response_ms = COALESCE(?, last_response_ms),
       last_page_size = COALESCE(?, last_page_size),
       last_platform = COALESCE(?, last_platform),
       last_hosting = COALESCE(?, last_hosting),
       last_security_headers = COALESCE(?, last_security_headers),
       monitor_state = ?,
       last_success_at = CASE WHEN ? IN ('ONLINE', 'DEGRADED') THEN datetime('now') ELSE last_success_at END,
       last_attempt_at = datetime('now'),
       last_state_notified_at = CASE WHEN ? <> ? THEN datetime('now') ELSE last_state_notified_at END,
       consecutive_failures = 0,
       last_error = NULL,
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
      result.seller,
      result.value,
      result.content,
      result.responseMs,
      result.pageSizeBytes,
      result.platform,
      result.hosting,
      result.securityHeaders,
      nextState,
      nextState,
      nextState,
      previousState,
      watch.id
    )
    .run();
}

export async function runAllChecks(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM watches WHERE active = 1 AND paused = 0").all<WatchRow>();

  for (let i = 0; i < results.length; i += CONCURRENCY) {
    const batch = results.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((watch) =>
        checkOne(env, watch).catch((err) => console.error(`check failed for watch ${watch.id}`, err))
      )
    );
  }
}
