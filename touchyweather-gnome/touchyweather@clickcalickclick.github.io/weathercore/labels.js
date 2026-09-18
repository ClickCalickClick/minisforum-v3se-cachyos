// Compass and band labels ported from the reference implementation.

/** 8-point compass label for a bearing. Port of `degToCompass()` (index.js:66). */
export function compass(degrees) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    // JS Math.round rounds .5 up like the reference JS; Swift used .rounded()
    // (schoolbook) which agrees for non-negative bearings.
    const idx = Math.round(degrees / 45) % 8;
    return dirs[((idx % 8) + 8) % 8];
}

/** UV index label (weather_data.c:111), full words. */
export function uvLabel(uv) {
    if (uv <= 2) return 'LOW';
    if (uv <= 5) return 'MODERATE';
    if (uv <= 7) return 'HIGH';
    if (uv <= 10) return 'VERY HIGH';
    return 'EXTREME';
}

/** US AQI label (weather_data.c:119), full words. */
export function aqiLabel(aqi) {
    if (aqi <= 50) return 'GOOD';
    if (aqi <= 100) return 'MODERATE';
    if (aqi <= 150) return 'UNHEALTHY (SENSITIVE)';
    if (aqi <= 200) return 'UNHEALTHY';
    if (aqi <= 300) return 'VERY UNHEALTHY';
    return 'HAZARDOUS';
}

/** Pollen UPI level label (0..5). */
export function pollenLabel(level) {
    switch (level) {
    case 0: return 'None';
    case 1: return 'Very Low';
    case 2: return 'Low';
    case 3: return 'Moderate';
    case 4: return 'High';
    default: return 'Very High';
    }
}
