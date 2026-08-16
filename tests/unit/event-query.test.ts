import { describe, expect, it } from "vitest";
import { appendEventTail } from "@archive/core";

describe("appendEventTail", () => {
  it("adds the configured event limit when the query has no tail", () => {
    expect(appendEventTail("@collect.host = updatepulse", 1000)).toBe(
      "@collect.host = updatepulse | tail(1000)",
    );
  });

  it("preserves an explicit query tail", () => {
    expect(appendEventTail("#repo=repo-a | tail(42)", 1000)).toBe("#repo=repo-a | tail(42)");
  });
});
