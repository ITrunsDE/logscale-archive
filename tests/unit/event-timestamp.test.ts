import { describe, expect, it } from "vitest";
import { resolveEventTimestamp } from "../../packages/core/src/results/events.js";

describe("resolveEventTimestamp", () => {
  it("parses epoch milliseconds numbers from LogScale", () => {
    expect(resolveEventTimestamp({ "@timestamp": 1786231824000 })).toBe("2026-08-08T23:30:24.000Z");
  });

  it("parses epoch millisecond numeric strings", () => {
    expect(resolveEventTimestamp({ "@timestamp": "1786231824000" })).toBe("2026-08-08T23:30:24.000Z");
  });

  it("parses ISO strings", () => {
    expect(resolveEventTimestamp({ "@timestamp": "2026-08-08T23:30:24.000Z" })).toBe(
      "2026-08-08T23:30:24.000Z",
    );
  });
});
