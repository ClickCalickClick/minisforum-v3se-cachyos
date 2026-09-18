import {HttpError} from '../http.js';

/**
 * RainViewer's public radar-frame manifest (keyless; api-contract.md §7).
 * Keeps the last ≤ 8 past frames, oldest-first.
 */
export class RainViewerClient {
    static maxFrames = 8;

    constructor(http, url = 'https://api.rainviewer.com/public/weather-maps.json') {
        this.http = http;
        this.url = url;
    }

    /** @returns {{host:string, generated:number, frames:{time:number, path:string}[]}} */
    async frames() {
        const manifest = await this.http.getJSON(this.url);
        const past = (manifest.radar?.past ?? [])
            .slice()
            .sort((a, b) => a.time - b.time)
            .slice(-RainViewerClient.maxFrames)
            .map(f => ({time: f.time, path: f.path}));
        if (past.length === 0) throw new HttpError('emptyBody', 'no past frames');
        return {host: manifest.host, generated: manifest.generated, frames: past};
    }
}
