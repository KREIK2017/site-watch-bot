import type { Env } from "./types";

export interface HistoryEntry {
  price: string | null;
  stock: string | null;
  status: number | null;
  checked_at: string;
}

// Only called when a check establishes the baseline or an actual price/stock
// change was detected — logging every 5-minute tick regardless would flood
// /history with identical readings instead of a useful timeline.
export async function recordHistory(
  env: Env,
  watchId: number,
  price: string | null,
  stock: string | null,
  status: number | null
): Promise<void> {
  if (!price && !stock) return;
  await env.DB.prepare(
    "INSERT INTO watch_history (watch_id, price, stock, status, checked_at) VALUES (?, ?, ?, ?, datetime('now'))"
  )
    .bind(watchId, price, stock, status)
    .run();
}

export async function getHistory(env: Env, watchId: number, limit = 15): Promise<HistoryEntry[]> {
  const { results } = await env.DB.prepare(
    "SELECT price, stock, status, checked_at FROM watch_history WHERE watch_id = ? ORDER BY checked_at DESC LIMIT ?"
  )
    .bind(watchId, limit)
    .all<HistoryEntry>();
  return results;
}

// watch_history.checked_at is sqlite's datetime('now') — "YYYY-MM-DD HH:MM:SS" in UTC.
export function formatHistoryDate(iso: string): string {
  const [datePart, timePart] = iso.split(" ");
  if (!datePart || !timePart) return iso;
  const [, month, day] = datePart.split("-");
  const [hh, mm] = timePart.split(":");
  return `${day}.${month} ${hh}:${mm}`;
}
