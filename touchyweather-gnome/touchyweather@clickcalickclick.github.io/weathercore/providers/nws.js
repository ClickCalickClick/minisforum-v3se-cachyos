import {buildURL} from '../http.js';
import {parseSeverity} from '../models.js';

/** NWS ISO-8601 with offset ("2026-07-18T08:16:00-05:00") → unix seconds. */
function parseDate(s) {
    if (!s) return null;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms / 1000;
}

/** Map one GeoJSON feature's properties to a WeatherAlert; null if no id/event. */
export function alertFromProperties(p) {
    if (!p || !p.id || !p.event) return null;
    return {
        id: p.id,
        event: p.event,
        severity: parseSeverity(p.severity),
        certainty: p.certainty ?? null,
        headline: p.headline ?? null,
        details: p.description ?? null,
        instruction: p.instruction ?? null,
        onset: parseDate(p.onset),
        ends: parseDate(p.ends),
    };
}

/**
 * Active NWS alerts for a point (api-contract.md §6). US only; the descriptive
 * User-Agent is mandatory. Any failure yields [] at the pipeline seam.
 */
export class NWSAlertsClient {
    constructor(http, appVersion = 'dev') {
        this.http = http;
        this.baseURL = 'https://api.weather.gov/alerts/active';
        this.userAgent = `TouchyWeatherGNOME/${appVersion} (jwuerz@gmail.com)`;
    }

    async fetchAlerts(latitude, longitude) {
        const res = await this.http.getJSON(buildURL(this.baseURL, {point: `${latitude},${longitude}`}), {
            'User-Agent': this.userAgent,
            'Accept': 'application/geo+json',
        });
        return (res.features ?? []).map(f => alertFromProperties(f.properties)).filter(a => a);
    }
}
