import { describe, expect, it, vi } from "vitest";
import {
  activateQueryVersion,
  createQueryDraft,
  deleteQueryVersion,
  listQueryNames,
  listQueryVersions,
  normalizeScheduleCron,
  renameQuery,
} from "@archive/core";
import type { Database } from "@archive/core";

describe("normalizeScheduleCron", () => {
  it("defaults blank cron to hourly UTC expression", () => {
    expect(normalizeScheduleCron(null)).toBe("0 * * * *");
    expect(normalizeScheduleCron("")).toBe("0 * * * *");
    expect(normalizeScheduleCron("  ")).toBe("0 * * * *");
    expect(normalizeScheduleCron("*/15 * * * *")).toBe("*/15 * * * *");
  });
});

describe("listQueryNames", () => {
  it("returns names with active flag for a connection", async () => {
    const query = vi.fn(async () => ({
      rows: [
        { name: "errors", active: false },
        { name: "events", active: true },
      ],
    }));
    const db = { query } as unknown as Database;

    await expect(listQueryNames(db, "conn-1")).resolves.toEqual([
      { name: "errors", active: false },
      { name: "events", active: true },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("bool_or(active)"), ["conn-1"]);
  });
});

describe("listQueryVersions", () => {
  it("includes nextRunAt from schedule when not paused", async () => {
    const next = new Date("2026-08-15T20:00:00.000Z");
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "v1",
          connection_id: "conn-1",
          name: "events",
          version_number: 1,
          query_text: "#repo=a",
          mode: "event",
          schedule_cron: "0 * * * *",
          schedule_timezone: "UTC",
          initial_start_at: new Date("2026-01-01T00:00:00.000Z"),
          correction_window_seconds: 0,
          retention_days: null,
          active: true,
          test_passed_at: null,
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          next_run_at: next,
          schedule_paused: false,
        },
      ],
    }));
    const db = { query } as unknown as Database;

    const versions = await listQueryVersions(db, "conn-1", "events");
    expect(versions[0]?.nextRunAt).toBe(next.toISOString());
    expect(query).toHaveBeenCalledWith(expect.stringContaining("query_schedules"), [
      "conn-1",
      "events",
    ]);
  });

  it("hides nextRunAt when schedule is paused", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "v1",
          connection_id: "conn-1",
          name: "events",
          version_number: 1,
          query_text: "#repo=a",
          mode: "event",
          schedule_cron: "0 * * * *",
          schedule_timezone: "UTC",
          initial_start_at: new Date("2026-01-01T00:00:00.000Z"),
          correction_window_seconds: 0,
          retention_days: null,
          active: false,
          test_passed_at: null,
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          next_run_at: new Date("2026-08-15T20:00:00.000Z"),
          schedule_paused: true,
        },
      ],
    }));
    const db = { query } as unknown as Database;

    const versions = await listQueryVersions(db, "conn-1", "events");
    expect(versions[0]?.nextRunAt).toBeNull();
  });
});

describe("activateQueryVersion", () => {
  it("creates a schedule for a legacy version without cron", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    query.mockResolvedValueOnce({
      rows: [
        {
          id: "v1",
          connection_id: "conn-1",
          name: "events",
          version_number: 1,
          query_text: "#repo=a",
          mode: "event",
          schedule_cron: null,
          schedule_timezone: "UTC",
          initial_start_at: new Date("2026-01-01T00:00:00.000Z"),
          correction_window_seconds: 0,
          retention_days: null,
          active: false,
          test_passed_at: new Date("2026-01-01T00:00:00.000Z"),
          created_at: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    const db = { query } as unknown as Database;

    await activateQueryVersion(db, "v1");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO query_schedules"),
      ["v1"],
    );
  });
});

describe("createQueryDraft", () => {
  it("stores default cron when scheduleCron is empty", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ endpoint: "https://x", repository: "r", token_ciphertext: Buffer.alloc(32) }],
      })
      .mockResolvedValueOnce({ rows: [{ max: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "v1",
            connection_id: "conn-1",
            name: "events",
            version_number: 1,
            query_text: "#repo=a | tail()",
            mode: "event",
            schedule_cron: "0 * * * *",
            schedule_timezone: "UTC",
            initial_start_at: new Date("2026-01-01T00:00:00.000Z"),
            correction_window_seconds: 300,
            retention_days: null,
            active: false,
            test_passed_at: null,
            created_at: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      });
    const db = { query } as unknown as Database;

    const result = await createQueryDraft(db, {
      connectionId: "conn-1",
      name: "events",
      queryText: "#repo=a | tail()",
      mode: "event",
      scheduleCron: "",
      initialStartAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result.version.scheduleCron).toBe("0 * * * *");
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO query_versions"),
      expect.arrayContaining(["0 * * * *", "UTC"]),
    );
  });
});

describe("renameQuery", () => {
  it("updates the query name when the target is free", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });
    const db = { query } as unknown as Database;

    await renameQuery(db, "conn-1", "events", "errors");
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("UPDATE query_versions"), [
      "conn-1",
      "events",
      "errors",
    ]);
  });

  it("rejects a taken name", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    const db = { query } as unknown as Database;

    await expect(renameQuery(db, "conn-1", "events", "errors")).rejects.toThrow("name_taken");
  });
});

describe("deleteQueryVersion", () => {
  it("refuses active versions", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "v1",
          connection_id: "conn-1",
          name: "events",
          version_number: 1,
          query_text: "#repo=a",
          mode: "event",
          schedule_cron: null,
          schedule_timezone: "UTC",
          initial_start_at: "2026-01-01T00:00:00.000Z",
          correction_window_seconds: 0,
          retention_days: null,
          active: true,
          test_passed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const db = { query, withTransaction: vi.fn() } as unknown as Database;

    await expect(deleteQueryVersion(db, "v1")).rejects.toThrow("active_version");
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});
