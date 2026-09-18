import {Emitter} from './signals.js';

/**
 * The single view-model over WeatherService (WeatherStore.swift): owns the
 * per-location snapshots and the refresh phase. `changed` fires on updates.
 */
export class WeatherStore {
    constructor({service, prefs, locationStore, analytics = null, notifications = null}) {
        this.service = service;
        this.prefs = prefs;
        this.locationStore = locationStore;
        this.analytics = analytics;
        this.notifications = notifications;
        this.changed = new Emitter();
        this.snapshotsByLocation = new Map();
        this.phase = {kind: 'idle'};       // {kind:'idle'} | {kind:'refreshing'} | {kind:'failed', message}
        this.debugFaults = 0;
    }

    get activeLocation() { return this.locationStore.activeLocation; }

    get activeSnapshot() {
        const id = this.locationStore.activeLocationID;
        return id ? this.snapshotsByLocation.get(id) ?? null : null;
    }

    /** Render the cache immediately (no network). */
    loadCachedSnapshots() {
        for (const location of this.locationStore.locations) {
            const cached = this.service.cachedSnapshot(location.id);
            if (cached) this.snapshotsByLocation.set(location.id, cached);
        }
        this.changed.emit();
    }

    /** Refresh the active location; keep cache on failure (constitution §7). */
    async refresh(force = false) {
        const location = this.locationStore.activeLocation;
        if (!location) {
            this.phase = {kind: 'idle'};
            this.changed.emit();
            return;
        }
        this.phase = {kind: 'refreshing'};
        this.changed.emit();
        try {
            const snapshot = await this.service.refresh(location, this.prefs.units, force);
            this.snapshotsByLocation.set(location.id, snapshot);
            this.phase = {kind: 'idle'};
            this.changed.emit();
            await this.analytics?.pingIfNeeded(location.latitude, location.longitude);
            await this.notifications?.evaluate(snapshot, this.prefs.notificationSettings);
        } catch (e) {
            if (!this.snapshotsByLocation.has(location.id)) {
                const cached = this.service.cachedSnapshot(location.id);
                if (cached) this.snapshotsByLocation.set(location.id, cached);
            }
            this.phase = this.snapshotsByLocation.has(location.id)
                ? {kind: 'idle'}
                : {kind: 'failed', message: WeatherStore._describe(e)};
            if (this.phase.kind === 'failed') console.warn(`TouchyWeather: refresh failed: ${e.message}`);
            this.changed.emit();
        }
    }

    // ---- debug fault injection (tasks.md M3.2) ----
    async setDebugFaults(faults) {
        this.debugFaults = faults;
        this.service.setFaults(faults);
        const id = this.locationStore.activeLocationID;
        if (id) this.service.resetBackoff(id);
        await this.refresh(true);
    }

    async toggleDebugFault(fault) {
        await this.setDebugFaults(this.debugFaults ^ fault);
    }

    async debugClearCacheAndReload() {
        const id = this.locationStore.activeLocationID;
        if (!id) return;
        this.service.clearCache(id);
        this.snapshotsByLocation.delete(id);
        this.service.resetBackoff(id);
        await this.refresh(true);
    }

    static _describe(e) {
        if (e?.name === 'HttpError') {
            if (e.kind === 'transport') return 'No connection';
            if (e.kind === 'status') return `Server error (${e.status})`;
        }
        return 'Couldn’t update';
    }
}
