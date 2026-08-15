const RESULT_CAP_PATTERN = /result\s*(limit|cap)|truncat|exceeded.*limit|too many/i;

export function parseQueryJobWarnings(body: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  if (Array.isArray(body.warnings)) {
    warnings.push(...body.warnings.map(String));
  }
  if (Array.isArray(body.messages)) {
    warnings.push(...body.messages.map(String));
  }
  if (body.warning != null) {
    warnings.push(String(body.warning));
  }
  return warnings;
}

export function hasResultCapWarning(warnings: string[]): boolean {
  return warnings.some((warning) => RESULT_CAP_PATTERN.test(warning));
}

export function formatFailureMetadata(warnings: string[]): string {
  return `result_cap: ${warnings.join("; ")}`.slice(0, 500);
}
