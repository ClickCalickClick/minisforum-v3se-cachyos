import {Emitter} from './signals.js';
import {CURRENT_LOCATION_ID} from '../weathercore/models.js';
import {geocodingResultToLocation} from '../weathercore/providers/geocoding.js';

/**
 * The saved-locations model (LocationStore.swift): CRUD + persistence over
 * LocationsFile, the pinned Current Location entry via LocationService, and
 * the spec.md US-3 denied-permission ladder. `changed` fires on every mutation.
 */
export class LocationStore {
    constructor({fileStore, service, prefs}) {
        this.fileStore = fileStore;
        this.service = service;
        this.prefs = prefs;
        this.changed = new Emitter();
        this._file = fileStore.load();
        this.previewLocation = null;
        this.locationDenied = false;
        this.isLocatingFirstFix = false;
        this.showDeniedHint = false;
        /** 'geoclue' | 'ip' | null — how the pinned entry was last fixed. */
        this.currentLocationSource = null;
    }

    // ---- read surface ----
    get locations() { return this._file.locations; }
    get saved() { return this._file.saved; }
    get currentLocation() { return this._file.currentLocation; }
    get activeLocation() { return this.previewLocation ?? this._file.activeLocation; }
    get activeLocationID() { return this.previewLocation?.id ?? this._file.activeLocationID; }
    get isPreviewingUnsaved() { return this.previewLocation !== null; }

    /** 'onboarding' when no usable location exists; else 'ready'. */
    get mode() {
        if (this._file.locations.length === 0 && !this.previewLocation) return 'onboarding';
        if (this.locationDenied && this._file.saved.length === 0 && !this.previewLocation) return 'onboarding';
        return 'ready';
    }

    // ---- saved-location CRUD ----
    preview(result) {
        this.previewLocation = geocodingResultToLocation(result);
        this.changed.emit();
    }

    clearPreview() {
        this.previewLocation = null;
        this.changed.emit();
    }

    savePreview() {
        if (!this.previewLocation) return null;
        const id = this._file.add(this.previewLocation);
        this._file.setActive(id);
        this.previewLocation = null;
        this._persist();
        return id;
    }

    remove(id) {
        if (!this._file.remove(id)) return;
        this._persist();
    }

    moveSaved(fromIndex, toIndex) {
        this._file.moveSaved(fromIndex, toIndex);
        this._persist();
    }

    setActive(id) {
        this.previewLocation = null;
        if (!this._file.setActive(id)) {
            this.changed.emit();
            return;
        }
        this._persist();
    }

    // ---- Current Location ----

    /**
     * Refresh the pinned entry from a one-shot fix. Safe to call every refresh:
     * the ladder handles denial; transient errors retry next time. Never nags
     * twice: a denial is remembered for the session, and the GeoClue agent
     * itself remembers the user's answer in the permission store.
     */
    async updateCurrentLocation() {
        // Nothing can produce a fix (services off, no IP fallback): don't even
        // try again this session — just keep the ladder's choice in place.
        if (this.locationDenied && !this.service.systemLocationEnabled && !this.prefs.ipLocationFallback) {
            this._applyDeniedLadder();
            return;
        }
        if (!this.prefs.hasRequestedLocationAuth) this.prefs.hasRequestedLocationAuth = true;

        this.isLocatingFirstFix = this._file.currentLocation === null && this._file.saved.length === 0;
        if (this.isLocatingFirstFix) this.changed.emit();
        try {
            const fix = await this.service.requestFix();
            let name = fix.name ?? null, countryCode = fix.countryCode ?? null;
            if (!name) {
                const place = await this.service.resolvePlace(fix.latitude, fix.longitude);
                name = place.name; countryCode = countryCode ?? place.countryCode;
            }
            this._file.upsertCurrentLocation({latitude: fix.latitude, longitude: fix.longitude, name, countryCode});
            this.currentLocationSource = fix.source;
            this.locationDenied = false;
            this._persist();
        } catch (e) {
            if (e.kind === 'denied' || e.kind === 'restricted') this._applyDeniedLadder();
            else console.debug?.(`TouchyWeather: no location fix this cycle (${e.message})`);
        } finally {
            this.isLocatingFirstFix = false;
            this.changed.emit();
        }
    }

    /** The US-3 ladder on denial: promote the first saved place (one-time hint) or onboarding. */
    _applyDeniedLadder() {
        this.locationDenied = true;
        const onCurrentOrNothing = this._file.activeLocation === null || this._file.activeLocationID === CURRENT_LOCATION_ID;
        if (onCurrentOrNothing && this._file.saved.length > 0) {
            this._file.setActive(this._file.saved[0].id);
            if (!this.prefs.hasShownDeniedHint) {
                this.showDeniedHint = true;
                this.prefs.hasShownDeniedHint = true;
            }
        }
        this._persist();
    }

    dismissDeniedHint() {
        this.showDeniedHint = false;
        this.changed.emit();
    }

    _persist() {
        try {
            this.fileStore.save(this._file);
        } catch (e) {
            console.error(`TouchyWeather: locations save failed: ${e.message}`);
        }
        this.changed.emit();
    }
}
