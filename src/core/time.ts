export const MINUTE_MS = 60_000;

/** UTC `YYYY-MM-DD HH:mm:ss.SSS`, the format Logs Insights uses for @timestamp. */
export function formatInsightsTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export function minuteFloor(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
