export type QueryMode = "event" | "aggregate";

export type QueryValidation = {
  ok: boolean;
  errors: string[];
};

const HEAD_PATTERN = /\bhead\s{0,20}\(/i;
const TAIL_LIMIT_PATTERN = /\btail\s{0,20}\(\s{0,20}\d+/i;
const TIME_CHART_CALL = /\btimeChart\s{0,20}\(/i;
const HASH_WINDOW = /#(?:timeChart|bucket)\b/i;
const BUCKET_CALL = /\bbucket\s{0,20}\([^)]{0,200},\s{0,20}[^)]{1,200}\)/i;
const SPAN_EQ = /\bspan\s{0,20}=\s{0,20}\d+/i;

export function validateQueryText(queryText: string, mode: QueryMode): QueryValidation {
  const errors: string[] = [];
  const trimmed = queryText.trim();

  if (!trimmed) {
    errors.push("Query text is required");
  }
  if (HEAD_PATTERN.test(queryText)) {
    errors.push("head() is not allowed; the collector controls result limits");
  }
  if (TAIL_LIMIT_PATTERN.test(queryText)) {
    errors.push("tail(n) with a numeric limit is not allowed; the collector controls result limits");
  }
  if (
    mode === "aggregate" &&
    !TIME_CHART_CALL.test(queryText) &&
    !HASH_WINDOW.test(queryText) &&
    !BUCKET_CALL.test(queryText) &&
    !SPAN_EQ.test(queryText)
  ) {
    errors.push("Aggregate queries must declare a fixed time window");
  }

  return { ok: errors.length === 0, errors };
}

export function validateEventResults(events: unknown[]): QueryValidation {
  if (events.length === 0) {
    return { ok: true, errors: [] };
  }

  const errors: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") {
      errors.push("Event results must include @id and #repo fields");
      break;
    }
    const record = event as Record<string, unknown>;
    if (record["@id"] == null || record["@id"] === "") {
      errors.push("Event results must include @id field");
    }
    if (record["#repo"] == null || record["#repo"] === "") {
      errors.push("Event results must include #repo field");
    }
    if (errors.length > 0) {
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateAggregateResults(
  events: unknown[],
  windowStart: string,
  windowEnd: string,
): QueryValidation {
  if (events.length === 0) {
    return { ok: true, errors: [] };
  }

  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { ok: false, errors: ["Invalid sample window"] };
  }

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as Record<string, unknown>;
    const bucket = record._time ?? record["@timestamp"] ?? record.timestamp;
    if (bucket == null) {
      return { ok: false, errors: ["Aggregate results must include a fixed window timestamp"] };
    }
    const bucketMs = Date.parse(String(bucket));
    if (Number.isNaN(bucketMs) || bucketMs < startMs || bucketMs >= endMs) {
      return {
        ok: false,
        errors: ["Aggregate results must fall within the declared sample window"],
      };
    }
  }

  return { ok: true, errors: [] };
}
