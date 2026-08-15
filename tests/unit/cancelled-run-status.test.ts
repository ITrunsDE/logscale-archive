import { describe, expect, it } from "vitest";
import { isListableQueryRunStatus } from "../../packages/core/src/jobs/leases.js";

describe("cancelled query run status", () => {
  it("is a listable operations status", () => {
    expect(isListableQueryRunStatus("cancelled")).toBe(true);
  });
});
