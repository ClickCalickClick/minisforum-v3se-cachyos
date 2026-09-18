import {buildURL} from '../http.js';
import {UnitsInfo} from '../models.js';

/** Open-Meteo forecast (api-contract.md §1) — the one required call. */
export class OpenMeteoForecastClient {
    constructor(http) {
        this.http = http;
        this.baseURL = 'https://api.open-meteo.com/v1/forecast';
    }

    fetch(latitude, longitude, units) {
        return this.http.getJSON(buildURL(this.baseURL, {
            latitude, longitude,
            current: 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code,wind_speed_10m,wind_direction_10m,uv_index,is_day',
            hourly: 'temperature_2m,weather_code,precipitation_probability,wind_speed_10m,wind_direction_10m,precipitation,uv_index',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max',
            temperature_unit: UnitsInfo.openMeteoTemperatureUnit(units),
            wind_speed_unit: UnitsInfo.openMeteoWindSpeedUnit(units),
            timezone: 'auto',
            forecast_days: 7,
        }));
    }
}
