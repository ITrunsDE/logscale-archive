type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

let displayTimezone = "UTC";

export function setDisplayTimezone(timezone: string): void {
  displayTimezone = timezone;
}

export function getDisplayTimezone(): string {
  return displayTimezone;
}

const numericParts = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function partsAt(date: Date, timezone: string): ZonedParts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      ...numericParts.resolvedOptions(),
      timeZone: timezone,
    })
      .formatToParts(date)
      .filter((part) => ["year", "month", "day", "hour", "minute"].includes(part.type))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<keyof ZonedParts, number>;
  return values;
}

function sameParts(a: ZonedParts, b: ZonedParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

export function formatDateTime(value: string | null, timezone: string): string {
  if (!value || Number.isNaN(new Date(value).getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function toDisplayLocalInput(value: string, timezone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = partsAt(date, timezone);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function fromDisplayLocalInput(value: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const target: ZonedParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const nominal = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const offsets = new Set<number>();
  for (let hours = -24; hours <= 24; hours += 1) {
    const instant = nominal + hours * 3_600_000;
    const parts = partsAt(new Date(instant), timezone);
    offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant);
  }
  const matches = [...offsets]
    .map((offset) => new Date(nominal - offset))
    .filter((candidate) => sameParts(partsAt(candidate, timezone), target))
    .sort((a, b) => a.getTime() - b.getTime());
  return matches[0]?.toISOString() ?? null;
}
