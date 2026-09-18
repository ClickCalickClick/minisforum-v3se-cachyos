import {buildURL} from '../http.js';
import {LocationKind, makeLocation} from '../models.js';

/** "San Francisco, California, United States" — the search-result label. */
export function geocodingDisplayLabel(result) {
    return [result.name, result.admin1, result.country].filter(s => s).join(', ');
}

/** Materialize a savable location from a hit (fresh id; add() dedupes by coords). */
export function geocodingResultToLocation(result) {
    return makeLocation({
        kind: LocationKind.SAVED,
        name: result.name,
        admin1: result.admin1 ?? null,
        countryCode: result.country_code ?? null,
        latitude: result.latitude,
        longitude: result.longitude,
        timezoneIdentifier: result.timezone ?? null,
    });
}

/** City search for the Locations UI (api-contract.md §3). Keyless, optional. */
export class OpenMeteoGeocodingClient {
    static minimumQueryLength = 2;

    constructor(http) {
        this.http = http;
        this.baseURL = 'https://geocoding-api.open-meteo.com/v1/search';
    }

    /** Up to 10 matches, or [] for a too-short query / no-match response. */
    async search(query, cancellable = null) {
        const trimmed = (query ?? '').trim();
        if (trimmed.length < OpenMeteoGeocodingClient.minimumQueryLength) return [];
        const res = await this.http.getJSON(buildURL(this.baseURL, {
            name: trimmed, count: 10, language: 'en', format: 'json',
        }), {}, cancellable);
        return res.results ?? [];
    }
}
