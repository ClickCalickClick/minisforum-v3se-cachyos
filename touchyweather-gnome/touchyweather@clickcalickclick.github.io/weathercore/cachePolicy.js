// Freshness and TTL policy constants (index.js / comm.c). Seconds.
export const CachePolicy = Object.freeze({
    freshness: 15 * 60,          // FETCH_FRESH_MS
    inFlight: 20,                // FETCH_IN_FLIGHT_MS
    httpTimeout: 15,
    imageTimeout: 25,
    alertsTimeout: 6,            // NWS is optional and often slow; don't hold the refresh
    geocodeTTL: 24 * 60 * 60,    // GEO_TTL_MS
    pollenTTL: 6 * 60 * 60,      // POLLEN_TTL_MS
    isFresh(fetchedAt, now = Date.now() / 1000) {
        return now - fetchedAt < this.freshness;
    },
});
