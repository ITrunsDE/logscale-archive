type AttemptWindow = {
  failures: number;
  lockedUntil: number;
  windowStartedAt: number;
};

const attempts = new Map<string, AttemptWindow>();

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

function key(ip: string, username: string): string {
  return `${ip}:${username.toLowerCase()}`;
}

function freshWindow(now: number): AttemptWindow {
  return { failures: 0, lockedUntil: 0, windowStartedAt: now };
}

export function isLoginLocked(ip: string, username: string): boolean {
  const entry = attempts.get(key(ip, username));
  if (!entry) {
    return false;
  }
  return entry.lockedUntil > Date.now();
}

export function recordLoginFailure(ip: string, username: string): void {
  const k = key(ip, username);
  const now = Date.now();
  let entry = attempts.get(k);

  if (!entry || now - entry.windowStartedAt > WINDOW_MS) {
    entry = freshWindow(now);
  }

  if (entry.lockedUntil > now) {
    attempts.set(k, entry);
    return;
  }

  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
  }
  attempts.set(k, entry);
}

export function clearLoginFailures(ip: string, username: string): void {
  attempts.delete(key(ip, username));
}

export function resetLoginRateLimiter(): void {
  attempts.clear();
}
