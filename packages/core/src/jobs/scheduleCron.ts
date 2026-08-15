import { Cron } from "croner";

/** Next fire time strictly after `after` for a 5-field cron expression. */
export function computeNextRunAt(
  cronExpression: string,
  timezone: string,
  after: Date = new Date(),
): Date {
  let cron: Cron;
  try {
    cron = new Cron(cronExpression, { timezone, paused: true });
  } catch {
    throw Object.assign(new Error("invalid_cron"), { cronExpression, timezone });
  }

  const next = cron.nextRun(after);
  if (!next) {
    throw Object.assign(new Error("invalid_cron"), { cronExpression, timezone });
  }
  return next;
}
