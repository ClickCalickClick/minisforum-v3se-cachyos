import {buildURL} from '../http.js';

/** Display name = first non-empty of city, locality, principalSubdivision. */
export function bdcResolvedName(r) {
    for (const c of [r.city, r.locality, r.principalSubdivision]) {
        if (c) return c;
    }
    return null;
}

/** Reverse geocoding for the current-location name (api-contract.md §4). */
export class BigDataCloudGeocoder {
    constructor(http) {
        this.http = http;
        this.baseURL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
    }

    reverseGeocode(latitude, longitude) {
        return this.http.getJSON(buildURL(this.baseURL, {latitude, longitude, localityLanguage: 'en'}));
    }

    /**
     * Linux addition: with no coordinates the same keyless endpoint geolocates
     * the caller's IP (`lookupSource: "ip geolocation"`). Used as the
     * opt-in fallback when GeoClue is unavailable or denied.
     */
    async locateByIP() {
        const r = await this.http.getJSON(buildURL(this.baseURL, {localityLanguage: 'en'}));
        if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return null;
        return {latitude: r.latitude, longitude: r.longitude, name: bdcResolvedName(r), countryCode: r.countryCode ?? null};
    }
}
