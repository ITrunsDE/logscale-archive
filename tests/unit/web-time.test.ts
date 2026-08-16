import { describe, expect, it } from "vitest";
import { formatDateTime, fromDisplayLocalInput } from "../../apps/web/src/client/time.js";

describe("web time", () => {
  it("formats timestamps in the configured timezone", () => {
    expect(formatDateTime("2026-08-16T10:00:00.000Z", "Europe/Berlin")).toContain("12:00");
  });

  it("rejects nonexistent DST local times", () => {
    expect(fromDisplayLocalInput("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
  });

  it("uses the earlier occurrence of repeated DST local times", () => {
    expect(fromDisplayLocalInput("2026-10-25T02:30", "Europe/Berlin")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });
});
