import {Backoff} from './backoff.js';
import {CachePolicy} from './cachePolicy.js';
import {isEurope} from './derived.js';
import {assemble} from './assembler.js';
import {supportsAlerts} from './models.js';
import {HttpError} from './http.js';

/** Debug fault flags (spec.md US-2 error states are reachable via these). */
export const Faults = Object.freeze({FORECAST: 1, AIR_QUALITY: 2, POLLEN: 4, RADAR: 8, ALERTS: 16});

export class BackoffSuppressedError extends Error {
    constructor(retryAfter) {
        super(`backoff: retry in ${Math.round(retryAfter)}s`);
        this.name = 'BackoffSuppressedError';
        this.retryAfter = retryAfter;
    }
}

/**
 * The single weather orchestrator (WeatherService.swift): freshness gate,
 * failure backoff, concurrent fan-out of the required forecast + optional
 * air-quality / pollen / alerts, merge + derive, persist.
 */
export class WeatherService {
    constructor({forecastClient, airQualityClient, proxyClient = null, alertsProvider = null, cache, now = () => Date.now() / 1000}) {
        this.forecastClient = forecastClient;
        this.airQualityClient = airQualityClient;
        this.proxyClient = proxyClient;
        this.alertsProvider = alertsProvider;
        this.cache = cache;
        this.now = now;
        this._backoffByLocation = new Map();
        this.faults = 0;
    }

    setFaults(faults) {
        this.faults = faults;
    }

    clearCache(locationID) {
        this.cache.clear(locationID);
    }

    resetBackoff(locationID) {
        this._backoffByLocation.delete(locationID);
    }

    cachedSnapshot(locationID) {
        return this.cache.load(locationID);
    }

    /**
     * Freshest snapshot for a location — fetched when warranted, else cached.
     * `force` bypasses the 15-min gate but still respects backoff.
     */
    async refresh(location, units, force = false) {
        const cached = this.cache.load(location.id);
        const clock = this.now();

        if (!force && cached && cached.unitsUsed === units && CachePolicy.isFresh(cached.fetchedAt, clock))
            return cached;

        const backoff = this._backoffByLocation.get(location.id) ?? new Backoff();
        if (!backoff.mayRetry(clock)) {
            if (cached) return cached;
            const elapsed = backoff.lastFailureAt ? clock - backoff.lastFailureAt : 0;
            throw new BackoffSuppressedError(Math.max(0, backoff.currentDelay - elapsed));
        }

        try {
            const snapshot = await this._fetchAndAssemble(location, units, clock, cached);
            backoff.recordSuccess();
            this._backoffByLocation.set(location.id, backoff);
            try {
                this.cache.save(snapshot);
            } catch (e) {
                console.warn(`TouchyWeather: snapshot cache write failed: ${e.message}`);
            }
            return snapshot;
        } catch (e) {
            backoff.recordFailure(clock);
            this._backoffByLocation.set(location.id, backoff);
            throw e;
        }
    }

    async _fetchAndAssemble(location, units, clock, cached) {
        const europe = isEurope(location.latitude, location.longitude);
        const pollenStale = !cached?.pollenFetchedAt || clock - cached.pollenFetchedAt >= CachePolicy.pollenTTL;
        const shouldFetchPollen = !europe && this.proxyClient && pollenStale;
        const shouldFetchAlerts = supportsAlerts(location) && this.alertsProvider;
        const injected = this.faults;

        const forecastP = (async () => {
            if (injected & Faults.FORECAST) throw new HttpError('status', 'injected', 503);
            return this.forecastClient.fetch(location.latitude, location.longitude, units);
        })();
        const airQualityP = (async () => {
            if (injected & Faults.AIR_QUALITY) return null;
            try {
                return await this.airQualityClient.fetch(location.latitude, location.longitude);
            } catch (_e) {
                return null;
            }
        })();
        const pollenP = (async () => {
            if (!shouldFetchPollen) return {outcome: 'skipped'};
            if (injected & Faults.POLLEN) return {outcome: 'failed'};
            try {
                return {outcome: 'fetched', level: await this.proxyClient.pollenLevel(location.latitude, location.longitude)};
            } catch (_e) {
                return {outcome: 'failed'};
            }
        })();
        const alertsP = (async () => {
            if (!shouldFetchAlerts || (injected & Faults.ALERTS)) return [];
            try {
                return await this.alertsProvider.fetchAlerts(location.latitude, location.longitude);
            } catch (_e) {
                return [];   // NWS outages never delay or break the refresh
            }
        })();

        const [forecast, airQuality, pollen, alerts] = await Promise.all([forecastP, airQualityP, pollenP, alertsP]);

        const snapshot = assemble({location, units, forecast, airQuality, fetchedAt: clock});
        snapshot.alerts = alerts;

        if (!europe) {
            if (pollen.outcome === 'fetched') {
                snapshot.pollenLevel = pollen.level;
                snapshot.pollenFetchedAt = clock;
            } else {
                snapshot.pollenLevel = cached?.pollenLevel ?? null;
                snapshot.pollenFetchedAt = cached?.pollenFetchedAt ?? null;
            }
        }
        return snapshot;
    }
}
