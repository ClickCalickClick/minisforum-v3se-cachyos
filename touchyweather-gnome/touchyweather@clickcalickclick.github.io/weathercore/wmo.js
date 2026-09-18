import {Condition} from './models.js';

/**
 * Maps Open-Meteo WMO weather codes to `Condition`. Verbatim port of
 * `mapWeatherCode()` (reference index.js:53). First match wins; unknown codes
 * fall back to partlyCloudy.
 */
export function conditionForWMO(code) {
    if (code === 0) return Condition.SUNNY;
    if (code === 1 || code === 2) return Condition.PARTLY_CLOUDY;
    if (code === 3) return Condition.CLOUDY;
    if (code >= 45 && code <= 48) return Condition.FOG;
    if (code >= 51 && code <= 67) return Condition.RAIN;
    if (code >= 71 && code <= 77) return Condition.SNOW;
    if (code >= 80 && code <= 82) return Condition.RAIN;
    if (code >= 85 && code <= 86) return Condition.SNOW;
    if (code >= 95 && code <= 99) return Condition.STORM;
    return Condition.PARTLY_CLOUDY;
}
