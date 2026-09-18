// Models — the GJS port of WeatherCore/Models (Condition, Units, Location,
// WeatherAlert, MoonInfo, GoldenHours, WeatherSnapshot). Snapshots are plain
// JSON objects so they persist verbatim; every instant is unix *seconds*.

/** Weather condition, raw values identical to the Pebble `WeatherCondition`. */
export const Condition = Object.freeze({
    SUNNY: 0, PARTLY_CLOUDY: 1, CLOUDY: 2, RAIN: 3, SNOW: 4, STORM: 5, FOG: 6,
});

/** Short human description for the Current card (Condition.swift). */
export function conditionDescription(c) {
    switch (c) {
    case Condition.SUNNY: return 'Clear';
    case Condition.PARTLY_CLOUDY: return 'Partly Cloudy';
    case Condition.CLOUDY: return 'Cloudy';
    case Condition.RAIN: return 'Rain';
    case Condition.SNOW: return 'Snow';
    case Condition.STORM: return 'Storm';
    case Condition.FOG: return 'Fog';
    default: return 'Partly Cloudy';
    }
}

/**
 * Adwaita symbolic icon for a condition, choosing the day/night variant. The
 * SF Symbol → freedesktop icon mapping (`isDay` only affects sunny/partly).
 */
export function conditionIconName(c, isDay) {
    switch (c) {
    case Condition.SUNNY: return isDay ? 'weather-clear-symbolic' : 'weather-clear-night-symbolic';
    case Condition.PARTLY_CLOUDY: return isDay ? 'weather-few-clouds-symbolic' : 'weather-few-clouds-night-symbolic';
    case Condition.CLOUDY: return 'weather-overcast-symbolic';
    case Condition.RAIN: return 'weather-showers-symbolic';
    case Condition.SNOW: return 'weather-snow-symbolic';
    case Condition.STORM: return 'weather-storm-symbolic';
    case Condition.FOG: return 'weather-fog-symbolic';
    default: return 'weather-few-clouds-symbolic';
    }
}

/** Measurement system, mirroring the Pebble `Units` enum. */
export const Units = Object.freeze({IMPERIAL: 0, METRIC: 1});

export const UnitsInfo = {
    openMeteoTemperatureUnit: u => (u === Units.METRIC ? 'celsius' : 'fahrenheit'),
    openMeteoWindSpeedUnit: u => (u === Units.METRIC ? 'kmh' : 'mph'),
    windSpeedLabel: u => (u === Units.METRIC ? 'km/h' : 'mph'),
    precipitationLabel: u => (u === Units.METRIC ? 'mm' : 'in'),
};

/** Fixed, well-known id for the single pinned current-location entry. */
export const CURRENT_LOCATION_ID = '00000000-0000-0000-0000-0000000C0DE0';

export const LocationKind = Object.freeze({CURRENT: 'currentLocation', SAVED: 'saved'});

/** A place the app shows weather for (data-model.md §3). */
export function makeLocation({
    id = null, kind, name, admin1 = null, countryCode = null,
    latitude, longitude, timezoneIdentifier = null,
}) {
    return {
        id: id ?? uuid(),
        kind, name, admin1, countryCode, latitude, longitude, timezoneIdentifier,
    };
}

/** True when NWS severe-weather alerts apply (US only, v1). */
export function supportsAlerts(location) {
    return (location.countryCode ?? '').toUpperCase() === 'US';
}

/** Display string "City, Admin1" (Admin1 omitted when absent). */
export function displayTitle(location) {
    if (location.admin1) return `${location.name}, ${location.admin1}`;
    return location.name;
}

/** NWS severity, ordered so `>=` expresses "at least as severe". */
export const Severity = Object.freeze({UNKNOWN: 0, MINOR: 1, MODERATE: 2, SEVERE: 3, EXTREME: 4});

export function parseSeverity(nws) {
    switch ((nws ?? '').toLowerCase()) {
    case 'extreme': return Severity.EXTREME;
    case 'severe': return Severity.SEVERE;
    case 'moderate': return Severity.MODERATE;
    case 'minor': return Severity.MINOR;
    default: return Severity.UNKNOWN;
    }
}

/** Combined moon display name, e.g. "WAXING CRESCENT". */
export function moonDisplayName(moon) {
    return moon.name2 ? `${moon.name1} ${moon.name2}` : moon.name1;
}

/** Age of a snapshot in seconds. */
export function snapshotAge(snapshot, nowSeconds = Date.now() / 1000) {
    return nowSeconds - snapshot.fetchedAt;
}

/** RFC 4122 v4 UUID, upper-case like Foundation's. */
export function uuid() {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
