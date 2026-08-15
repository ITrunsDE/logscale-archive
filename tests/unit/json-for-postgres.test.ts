import { describe, expect, it } from "vitest";
import { jsonForPostgres } from "../../packages/core/src/db/jsonForPostgres.js";

describe("jsonForPostgres", () => {
  it("strips null Unicode escapes that PostgreSQL jsonb rejects", () => {
    const raw = { msg: "a\u0000b", nested: { x: "\u0000" } };
    const json = jsonForPostgres(raw);
    expect(json).not.toContain("\\u0000");
    expect(JSON.parse(json)).toEqual({ msg: "ab", nested: { x: "" } });
  });

  it("leaves normal JSON unchanged", () => {
    const value = { ok: true, n: 1, s: "café" };
    expect(jsonForPostgres(value)).toBe(JSON.stringify(value));
  });
});
