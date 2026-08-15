export type UtcWindow = {
  start: string;
  end: string;
};

export const DEFAULT_MIN_WINDOW_MS = 60_000;

export function windowDurationMs(window: UtcWindow): number {
  return Date.parse(window.end) - Date.parse(window.start);
}

export function splitWindow(window: UtcWindow): [UtcWindow, UtcWindow] {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const midMs = startMs + Math.floor((endMs - startMs) / 2);
  const mid = new Date(midMs).toISOString();
  return [
    { start: window.start, end: mid },
    { start: mid, end: window.end },
  ];
}
