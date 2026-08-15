import { describe, expect, it } from "vitest";
import { computeNextRunAt } from "../../packages/core/src/jobs/scheduleCron.js";

describe("computeNextRunAt", () => {
  it("returns the next hourly tick after the given time", () => {
    const after = new Date("2026-08-15T19:20:00.000Z");
    const next = computeNextRunAt("0 * * * *", "UTC", after);
    expect(next.toISOString()).toBe("2026-08-15T20:00:00.000Z");
  });

  it("skips the current instant when after lands exactly on a tick", () => {
    const after = new Date("2026-08-15T19:00:00.000Z");
    const next = computeNextRunAt("0 * * * *", "UTC", after);
    expect(next.toISOString()).toBe("2026-08-15T20:00:00.000Z");
  });

  it("respects timezone", () => {
    // 19:30 UTC = 21:30 Europe/Berlin (UTC+2 in August)
    const after = new Date("2026-08-15T19:30:00.000Z");
    const next = computeNextRunAt("0 22 * * *", "Europe/Berlin", after);
    // next 22:00 Berlin = 20:00 UTC
    expect(next.toISOString()).toBe("2026-08-15T20:00:00.000Z");
  });

  it("throws on invalid cron", () => {
    expect(() => computeNextRunAt("not a cron", "UTC", new Date())).toThrow(/invalid_cron/);
  });
});
