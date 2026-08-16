import { describe, expect, it, vi } from "vitest";
import { logArchiveOutcome } from "../../apps/worker/src/main.js";

describe("worker operation logging", () => {
  it("reports a split as a successful informational outcome", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };

    logArchiveOutcome(logger, "run-1", "event", {
      ok: false,
      retryable: false,
      split: true,
    });

    expect(logger.info).toHaveBeenCalledWith("query_run.finished", {
      runId: "run-1",
      mode: "event",
      ok: true,
      retryable: false,
      split: true,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
