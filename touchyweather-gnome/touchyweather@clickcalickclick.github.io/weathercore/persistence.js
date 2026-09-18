import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {CURRENT_LOCATION_ID, LocationKind} from './models.js';
import {CachePolicy} from './cachePolicy.js';

// ---------------------------------------------------------------------------
// Directories. Mac: ~/Library/Application Support/TouchyWeather. Linux: the XDG
// data dir (~/.local/share/touchyweather) for state and the XDG cache dir
// (~/.cache/touchyweather) for regenerable imagery.
// ---------------------------------------------------------------------------

export function defaultDataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'touchyweather']);
}

export function defaultCacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'touchyweather']);
}

export function ensureDir(path) {
    GLib.mkdir_with_parents(path, 0o700);
}

// ---------------------------------------------------------------------------
// JSONFileStore — read/write JSON with an atomic replace.
// ---------------------------------------------------------------------------

export class JSONFileStore {
    /** Parsed JSON, or null when the file doesn't exist. Throws on corrupt JSON. */
    read(path) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return null;
        return JSON.parse(new TextDecoder().decode(contents));
    }

    write(value, path) {
        ensureDir(GLib.path_get_dirname(path));
        const file = Gio.File.new_for_path(path);
        const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
        file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
    }

    remove(path) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (_e) {
            // already gone
        }
    }
}

// ---------------------------------------------------------------------------
// LocationsFile — the `locations.json` schema + CRUD (LocationsFile.swift).
// Invariants restored by normalize(): at most one pinned current-location entry
// sorted first; activeLocationID always names a present location or is null.
// ---------------------------------------------------------------------------

export class LocationsFile {
    static currentSchemaVersion = 1;

    constructor({schemaVersion = 1, locations = [], activeLocationID = null} = {}) {
        this.schemaVersion = schemaVersion;
        this.locations = locations;
        this.activeLocationID = activeLocationID;
        this.normalize();
    }

    get currentLocation() {
        return this.locations.find(l => l.kind === LocationKind.CURRENT) ?? null;
    }

    get saved() {
        return this.locations.filter(l => l.kind === LocationKind.SAVED);
    }

    get activeLocation() {
        if (!this.activeLocationID) return null;
        return this.locations.find(l => l.id === this.activeLocationID) ?? null;
    }

    location(id) {
        return this.locations.find(l => l.id === id) ?? null;
    }

    /** Add a saved place (dedupe by rounded coordinates). Returns the surviving id. */
    add(location) {
        const existing = this.locations.find(l => l.kind === LocationKind.SAVED && LocationsFile._sameCoordinate(l, location));
        if (existing) return existing.id;
        const incoming = {...location, kind: LocationKind.SAVED};
        this.locations.push(incoming);
        this.normalize();
        return incoming.id;
    }

    /** Delete a saved place; the pinned entry is never deletable. */
    remove(id) {
        const idx = this.locations.findIndex(l => l.id === id);
        if (idx < 0 || this.locations[idx].kind !== LocationKind.SAVED) return false;
        this.locations.splice(idx, 1);
        this.normalize();
        return true;
    }

    /** Move a saved place by one step (offsets into `saved`). */
    moveSaved(fromIndex, toIndex) {
        const saved = this.saved;
        if (fromIndex < 0 || fromIndex >= saved.length || toIndex < 0 || toIndex >= saved.length) return;
        const [item] = saved.splice(fromIndex, 1);
        saved.splice(toIndex, 0, item);
        const current = this.currentLocation;
        this.locations = (current ? [current] : []).concat(saved);
        this.normalize();
    }

    setActive(id) {
        if (!this.locations.some(l => l.id === id)) return false;
        this.activeLocationID = id;
        return true;
    }

    /** Create/update the pinned current-location entry from a fresh fix. */
    upsertCurrentLocation({latitude, longitude, name = null, countryCode = null, timezoneIdentifier = null}) {
        const entry = this.currentLocation ?? {
            id: CURRENT_LOCATION_ID,
            kind: LocationKind.CURRENT,
            name: name ?? 'Current Location',
            admin1: null,
            countryCode: null,
            latitude, longitude,
            timezoneIdentifier: null,
        };
        entry.latitude = latitude;
        entry.longitude = longitude;
        if (name) entry.name = name;
        if (countryCode) entry.countryCode = countryCode;
        if (timezoneIdentifier) entry.timezoneIdentifier = timezoneIdentifier;
        this.locations = this.locations.filter(l => l.kind !== LocationKind.CURRENT);
        this.locations.unshift(entry);
        this.normalize();
    }

    removeCurrentLocation() {
        this.locations = this.locations.filter(l => l.kind !== LocationKind.CURRENT);
        this.normalize();
    }

    normalize() {
        const current = this.locations.filter(l => l.kind === LocationKind.CURRENT);
        const saved = this.locations.filter(l => l.kind === LocationKind.SAVED);
        this.locations = (current.length ? [current[0]] : []).concat(saved);
        if (this.activeLocationID && !this.locations.some(l => l.id === this.activeLocationID))
            this.activeLocationID = null;
        if (!this.activeLocationID)
            this.activeLocationID = this.locations[0]?.id ?? null;
    }

    toJSON() {
        return {schemaVersion: LocationsFile.currentSchemaVersion, locations: this.locations, activeLocationID: this.activeLocationID};
    }

    static _sameCoordinate(a, b) {
        const r = v => Math.round(v * 10_000) / 10_000;
        return r(a.latitude) === r(b.latitude) && r(a.longitude) === r(b.longitude);
    }
}

/** Reads/writes `locations.json`; a corrupt file is quarantined, never overwritten. */
export class LocationsFileStore {
    constructor(baseDirectory = defaultDataDir()) {
        this.path = GLib.build_filenamev([baseDirectory, 'locations.json']);
        this.store = new JSONFileStore();
    }

    load() {
        try {
            const raw = this.store.read(this.path);
            if (!raw) return new LocationsFile();
            if (raw.schemaVersion !== LocationsFile.currentSchemaVersion) {
                this._quarantine(`schemaVersion ${raw.schemaVersion}`);
                return new LocationsFile();
            }
            return new LocationsFile(raw);
        } catch (e) {
            this._quarantine(String(e));
            return new LocationsFile();
        }
    }

    save(file) {
        file.normalize();
        this.store.write(file.toJSON(), this.path);
    }

    _quarantine(reason) {
        const bad = `${this.path}.corrupt`;
        try {
            Gio.File.new_for_path(this.path).move(Gio.File.new_for_path(bad), Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (_e) { /* nothing to move */ }
        console.error(`TouchyWeather: unreadable locations.json (${reason}) — moved to ${bad}`);
    }
}

// ---------------------------------------------------------------------------
// SnapshotCache — one JSON file per location under snapshots/.
// ---------------------------------------------------------------------------

export class SnapshotCache {
    constructor(baseDirectory = defaultDataDir()) {
        this.dir = GLib.build_filenamev([baseDirectory, 'snapshots']);
        this.store = new JSONFileStore();
    }

    _path(id) {
        return GLib.build_filenamev([this.dir, `${id}.json`]);
    }

    load(locationID) {
        try {
            const snap = this.store.read(this._path(locationID));
            return snap && snap.schemaVersion === 1 ? snap : null;
        } catch (_e) {
            return null;    // regenerable — a bad cache file is simply ignored
        }
    }

    save(snapshot) {
        this.store.write(snapshot, this._path(snapshot.location.id));
    }

    clear(locationID) {
        this.store.remove(this._path(locationID));
    }
}

// ---------------------------------------------------------------------------
// GeocodeCache — reverse-geocode names per 0.01° cell, 24 h TTL.
// ---------------------------------------------------------------------------

export class GeocodeCache {
    constructor(baseDirectory = defaultDataDir(), now = () => Date.now() / 1000) {
        this.path = GLib.build_filenamev([baseDirectory, 'geocode.json']);
        this.fileStore = new JSONFileStore();
        this.now = now;
    }

    static key(latitude, longitude) {
        return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    }

    _load() {
        try {
            const raw = this.fileStore.read(this.path);
            return raw && raw.schemaVersion === 1 && raw.cells ? raw : {schemaVersion: 1, cells: {}};
        } catch (_e) {
            return {schemaVersion: 1, cells: {}};
        }
    }

    /** Cached name if fresh (within TTL). */
    name(latitude, longitude) {
        const cell = this._load().cells[GeocodeCache.key(latitude, longitude)];
        if (!cell) return null;
        return this.now() - cell.at < CachePolicy.geocodeTTL ? cell.name : null;
    }

    /** Last cached name regardless of age. */
    lastKnownName(latitude, longitude) {
        return this._load().cells[GeocodeCache.key(latitude, longitude)]?.name ?? null;
    }

    store(name, latitude, longitude) {
        const file = this._load();
        file.cells[GeocodeCache.key(latitude, longitude)] = {name, at: this.now()};
        try {
            this.fileStore.write(file, this.path);
        } catch (e) {
            console.warn(`TouchyWeather: geocode cache write failed: ${e.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// NotificationDedupState — the persisted ledger (data-model.md §11).
// ---------------------------------------------------------------------------

export class NotificationDedupState {
    static maxEntries = 200;
    static expiryAge = 30 * 24 * 60 * 60;

    constructor({schemaVersion = 1, fired = {}} = {}) {
        this.schemaVersion = schemaVersion;
        this.fired = {...fired};     // dedupKey → unix seconds
    }

    has(key) {
        return Object.prototype.hasOwnProperty.call(this.fired, key);
    }

    record(key, at) {
        this.fired[key] = at;
    }

    /** Drop expired entries, then cap at maxEntries by evicting the oldest. */
    prune(now, maxEntries = NotificationDedupState.maxEntries) {
        for (const [key, at] of Object.entries(this.fired)) {
            if (now - at >= NotificationDedupState.expiryAge) delete this.fired[key];
        }
        const keys = Object.keys(this.fired);
        if (keys.length > maxEntries) {
            keys.sort((a, b) => this.fired[a] - this.fired[b]);
            for (const key of keys.slice(0, keys.length - maxEntries)) delete this.fired[key];
        }
    }

    toJSON() {
        return {schemaVersion: 1, fired: this.fired};
    }
}

export class NotificationStateStore {
    constructor(baseDirectory = defaultDataDir()) {
        this.path = GLib.build_filenamev([baseDirectory, 'notification-state.json']);
        this.store = new JSONFileStore();
    }

    load() {
        try {
            const raw = this.store.read(this.path);
            return raw ? new NotificationDedupState(raw) : new NotificationDedupState();
        } catch (_e) {
            return new NotificationDedupState();
        }
    }

    save(state) {
        this.store.write(state.toJSON(), this.path);
    }
}
