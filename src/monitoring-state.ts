import type { AnalyzeResult, WatchRow } from "./types";

export const MONITOR_STATES = ["ONLINE", "OFFLINE", "DEGRADED", "BLOCKED", "UNKNOWN", "PAUSED"] as const;
export type MonitorState = (typeof MONITOR_STATES)[number];

const BLOCKED_PATTERNS = [
  /anti[- ]?bot/i,
  /cloudflare challenge/i,
  /automated (?:access|requests)/i,
  /автоматизован/i,
  /автоматическ/i,
  /captcha/i,
  /access (?:was )?(?:denied|restricted)/i,
  /доступ обмеж/i,
  /доступ огранич/i,
];

export function isBlockedError(error: string | null | undefined): boolean {
  return Boolean(error && BLOCKED_PATTERNS.some((pattern) => pattern.test(error)));
}

export function deriveMonitorState(
  result: Pick<AnalyzeResult, "status" | "error">,
  paused = false
): MonitorState {
  if (paused) return "PAUSED";
  if (isBlockedError(result.error)) return "BLOCKED";
  if (result.error || result.status === null) return "UNKNOWN";
  if (result.status >= 200 && result.status < 300) return "ONLINE";
  if (result.status >= 300 && result.status < 400) return "DEGRADED";
  return "OFFLINE";
}

export function stateFromWatch(
  watch: Pick<WatchRow, "monitor_state" | "paused" | "last_status" | "last_error">
): MonitorState {
  if (watch.paused) return "PAUSED";
  if (MONITOR_STATES.includes(watch.monitor_state as MonitorState)) return watch.monitor_state as MonitorState;
  return deriveMonitorState({ status: watch.last_status, error: watch.last_error ?? undefined });
}

export function isSuccessfulState(state: MonitorState): boolean {
  return state === "ONLINE" || state === "DEGRADED";
}

export function isProductWatch(
  watch: Pick<WatchRow, "monitor_type" | "last_price" | "last_stock" | "last_seller">
): boolean {
  if (watch.monitor_type === "product") return true;
  if (watch.monitor_type === "site") return false;
  return Boolean(watch.last_price || watch.last_stock || watch.last_seller);
}
