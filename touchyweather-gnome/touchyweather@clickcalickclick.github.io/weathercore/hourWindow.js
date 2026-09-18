/**
 * Locates the "now" index within Open-Meteo hourly arrays by matching
 * `current.time` truncated to the hour — never the client clock (index.js:425).
 */
export function startIndex(hourlyTimes, currentTime) {
    if (!hourlyTimes || hourlyTimes.length === 0) return 0;
    if (!currentTime || currentTime.length < 13) return 0;
    const nowKey = `${currentTime.slice(0, 13)}:00`;
    const k = hourlyTimes.indexOf(nowKey);
    return k < 0 ? 0 : k;
}
