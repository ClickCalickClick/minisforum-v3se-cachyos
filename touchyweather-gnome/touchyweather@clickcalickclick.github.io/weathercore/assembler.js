import {compass} from './labels.js';
import {conditionForWMO} from './wmo.js';
import {startIndex} from './hourWindow.js';
import {instant} from './localTime.js';
import {rainAlertMinutes, pollenUPI, isEurope} from './derived.js';
import {moonPhase, goldenHours} from './astronomy.js';

/** Safe, flattening access: out-of-range or null both yield null. */
const flat = (arr, i) => (arr && i >= 0 && i < arr.length && arr[i] !== null && arr[i] !== undefined ? arr[i] : null);
const roundInt = v => Math.round(v ?? 0);
const roundIntOpt = v => (v === null || v === undefined ? null : Math.round(v));

/**
 * Merge a raw Open-Meteo forecast response (+ optional air-quality response)
 * into a fully derived snapshot (SnapshotAssembler.swift). Pure and synchronous.
 */
export function assemble({location, units, forecast, airQuality, fetchedAt}) {
    const offset = forecast.utc_offset_seconds ?? 0;
    const current = forecast.current;
    const hourly = forecast.hourly;
    const daily = forecast.daily;

    const startIdx = startIndex(hourly.time, current.time);

    const precipProbNext5 = [0, 1, 2, 3, 4].map(k => flat(hourly.precipitation_probability, startIdx + k) ?? 0);

    const amountsFromNow = [];
    for (let j = 0; j < 7; j++) {
        if (startIdx + j >= (hourly.precipitation?.length ?? 0)) break;
        amountsFromNow.push(flat(hourly.precipitation, startIdx + j) ?? 0);
    }
    const rainAlert = rainAlertMinutes(amountsFromNow);

    const hourlyEntries = [];
    for (let i = startIdx + 1; i < hourly.time.length && hourlyEntries.length < 24; i++) {
        const time = instant(hourly.time[i], offset);
        if (time === null) continue;
        hourlyEntries.push({
            time,
            temperature: flat(hourly.temperature_2m, i) ?? 0,
            condition: conditionForWMO(flat(hourly.weather_code, i) ?? 0),
            precipProbability: flat(hourly.precipitation_probability, i) ?? 0,
            precipAmount: flat(hourly.precipitation, i) ?? 0,
            windSpeed: flat(hourly.wind_speed_10m, i) ?? 0,
            windDirection: compass(flat(hourly.wind_direction_10m, i) ?? 0),
            uv: roundInt(flat(hourly.uv_index, i)),
        });
    }

    const dailyEntries = [];
    for (let d = 0; d < (daily.time?.length ?? 0); d++) {
        const date = instant(daily.time[d], offset);
        if (date === null) continue;
        dailyEntries.push({
            date,
            high: flat(daily.temperature_2m_max, d) ?? 0,
            low: flat(daily.temperature_2m_min, d) ?? 0,
            condition: conditionForWMO(flat(daily.weather_code, d) ?? 0),
            precipProbabilityMax: flat(daily.precipitation_probability_max, d) ?? 0,
        });
    }

    const dailyUVMax = flat(daily.uv_index_max, 0);
    const uv = roundIntOpt(current.uv_index) ?? roundIntOpt(dailyUVMax);

    const aq = airQuality?.current ?? null;
    let pollen = null;
    if (isEurope(location.latitude, location.longitude) && aq) {
        pollen = pollenUPI({
            grass: aq.grass_pollen, birch: aq.birch_pollen, alder: aq.alder_pollen,
            ragweed: aq.ragweed_pollen, mugwort: aq.mugwort_pollen, olive: aq.olive_pollen,
        });
    }

    return {
        schemaVersion: 1,
        location,
        fetchedAt,
        unitsUsed: units,
        utcOffsetSeconds: offset,
        timezoneIdentifier: forecast.timezone ?? null,
        temperature: current.temperature_2m,
        feelsLike: current.apparent_temperature,
        high: flat(daily.temperature_2m_max, 0),
        low: flat(daily.temperature_2m_min, 0),
        condition: conditionForWMO(current.weather_code),
        isDay: current.is_day === 1,
        windSpeed: current.wind_speed_10m,
        windDirection: compass(current.wind_direction_10m),
        humidity: current.relative_humidity_2m,
        dewPoint: current.dew_point_2m,
        precipProbNext5,
        rainAlertMinutes: rainAlert,
        uv,
        uvMax: roundIntOpt(dailyUVMax),
        aqi: aq?.us_aqi ?? null,
        pm25: roundIntOpt(aq?.pm2_5),
        pm10: roundIntOpt(aq?.pm10),
        o3: roundIntOpt(aq?.ozone),
        no2: roundIntOpt(aq?.nitrogen_dioxide),
        pollenLevel: pollen,
        pollenFetchedAt: null,
        hourly: hourlyEntries,
        daily: dailyEntries,
        sunrise: instant(flat(daily.sunrise, 0), offset),
        sunset: instant(flat(daily.sunset, 0), offset),
        moon: moonPhase(fetchedAt),
        goldenHours: goldenHours(fetchedAt, location.latitude, location.longitude),
        alerts: [],
    };
}
