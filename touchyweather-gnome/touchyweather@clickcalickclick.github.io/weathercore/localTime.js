/**
 * Parses Open-Meteo's offset-less local timestamps ("2026-07-16T13:00" or
 * "2026-07-16") into true unix seconds, given the location's utc_offset_seconds.
 * The string is read as UTC then shifted by the offset (LocalTime.swift).
 */
export function instant(string, utcOffsetSeconds) {
    if (!string) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(string);
    if (!m) return null;
    const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    return asUTC / 1000 - utcOffsetSeconds;
}
