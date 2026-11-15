// Operational clocks accept ISO calendar dates with seconds, optional exactly
// three millisecond digits, and Z or ±HH:MM. No local times or date rollover.
export function parseIntakeTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[1].startsWith("0000") || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return null;
  const zone = match[6];
  if (zone !== "Z" && (+zone.slice(1, 3) > 14 || +zone.slice(4) > 59 || (+zone.slice(1, 3) === 14 && +zone.slice(4) !== 0))) return null;
  const local = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 10) !== match[1]) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= -62135596800000 && ms <= 253402300799999 ? ms : null;
}

/** Same grammar/calendar validation in SQLite; compare instants, never strings. */
export function intakeJulianSql(column: string): string {
  const base = `substr(${column}, 1, 19)`;
  const zone = `(CASE WHEN substr(${column}, 20, 1) = '.' THEN substr(${column}, 24) ELSE substr(${column}, 20) END)`;
  return `(CASE WHEN
    ${base} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
    AND substr(${column}, 1, 4) != '0000'
    AND date(substr(${column}, 1, 10), '+0 days') = substr(${column}, 1, 10)
    AND substr(${column}, 12, 2) <= '23' AND substr(${column}, 15, 2) <= '59' AND substr(${column}, 18, 2) <= '59'
    AND (substr(${column}, 20, 1) != '.' OR substr(${column}, 20, 4) GLOB '.[0-9][0-9][0-9]')
    AND (${zone} = 'Z' OR (${zone} GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND substr(${zone}, 2, 2) <= '14' AND substr(${zone}, 5, 2) <= '59' AND (substr(${zone}, 2, 2) != '14' OR substr(${zone}, 5, 2) = '00')))
    AND julianday(${column}) >= 1721425.5 AND julianday(${column}) < 5373484.5
    THEN julianday(${column}) END)`;
}

// A corrupt non-NULL arrival is never repaired using a different clock.
export const INTAKE_ACTIVITY_SQL = intakeJulianSql("CASE WHEN arrived_at IS NULL THEN created_at ELSE arrived_at END");

export function intakeActivityLabel(intake: { arrived_at: string | null; created_at: string }): string {
  const legacy = intake.arrived_at === null;
  const ms = parseIntakeTime(legacy ? intake.created_at : intake.arrived_at);
  if (ms === null || ms > Date.now()) return legacy ? "Legacy processing time unavailable" : "Worker arrival unavailable";
  return `${legacy ? "Legacy processing time" : "Worker arrival"}: ${new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;
}
