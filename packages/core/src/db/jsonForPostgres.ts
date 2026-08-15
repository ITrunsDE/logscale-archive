/** PostgreSQL jsonb rejects \u0000 in strings. Strip after stringify. */
export function jsonForPostgres(value: unknown): string {
  return JSON.stringify(value).replace(/\\u0000/g, "");
}
