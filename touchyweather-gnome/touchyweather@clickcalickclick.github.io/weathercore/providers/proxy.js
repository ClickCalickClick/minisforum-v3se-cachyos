import {buildURL} from '../http.js';

/**
 * The TouchyWeather Vercel proxy (api-contract.md §§5, 8): Google-Pollen
 * fallback outside the CAMS Europe box, and the anonymous analytics ping.
 * Auth is the shared `key` query param; an empty/wrong key yields 401 and the
 * caller degrades silently.
 */
export class ProxyClient {
    constructor(http, key, baseURL = 'https://touchyweather-radar-proxy.vercel.app') {
        this.http = http;
        this.key = key;
        this.baseURL = baseURL;
    }

    /** Pollen level 0…5, or null when uncovered (level −1). Throws on HTTP failure. */
    async pollenLevel(latitude, longitude) {
        const res = await this.http.getJSON(buildURL(`${this.baseURL}/api/pollen`, {
            key: this.key, lat: latitude, lon: longitude,
        }));
        const level = res.level;
        if (typeof level !== 'number' || level < 0) return null;
        return level;
    }

    /** One anonymous active-user ping; coords pre-rounded to 0.1°. */
    track(id, latitude, longitude) {
        const rLat = Math.round(latitude * 10) / 10;
        const rLon = Math.round(longitude * 10) / 10;
        return this.http.postJSON(buildURL(`${this.baseURL}/api/track`, {key: this.key}),
            {id, lat: rLat, lon: rLon, variant: 'gnome'});
    }
}
