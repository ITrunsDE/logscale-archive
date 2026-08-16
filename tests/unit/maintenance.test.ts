import { describe, expect, it } from "vitest";
import { getMaintenanceState } from "@archive/core";

describe("getMaintenanceState", () => {
  it("is inactive when DATA_PATH is not configured", () => {
    expect(getMaintenanceState({})).toEqual({ active: false });
  });
});
