import {buildURL} from '../http.js';

/** Open-Meteo air quality + European pollen (api-contract.md §2). Optional. */
export class OpenMeteoAirQualityClient {
    constructor(http) {
        this.http = http;
        this.baseURL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
    }

    fetch(latitude, longitude) {
        return this.http.getJSON(buildURL(this.baseURL, {
            latitude, longitude,
            current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen,mugwort_pollen,olive_pollen',
            timezone: 'auto',
        }));
    }
}
