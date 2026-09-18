import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Geoclue from 'gi://Geoclue';

import {bdcResolvedName} from '../weathercore/providers/bigDataCloud.js';

Gio._promisify(Geoclue.Simple, 'new');

/** Why a fix couldn't be produced — the legs that drive the US-3 ladder. */
export class LocationError extends Error {
    constructor(kind, detail = '') {
        super(`${kind}${detail ? `: ${detail}` : ''}`);
        this.name = 'LocationError';
        this.kind = kind;    // 'denied' | 'restricted' | 'noFix'
    }
}

/** The desktop id the GeoClue agent authorizes; install.sh ships the .desktop. */
export const GEOCLUE_DESKTOP_ID = 'touchyweather';

/**
 * One-shot GeoClue fix + reverse-geocoded name for the pinned Current Location
 * entry (LocationService.swift). GeoClue is the CoreLocation stand-in: the
 * GNOME Shell agent shows the permission dialog the first time (it needs
 * `touchyweather.desktop` to be installed), and Location Services can be
 * switched off globally in Settings → Privacy. When GeoClue is denied or
 * unavailable and the user allows it, the keyless BigDataCloud IP lookup gives
 * a city-level "approximate" fix — Linux desktops rarely have a better sensor.
 */
export class LocationService {
    constructor({geocoder, nameCache, prefs}) {
        this.geocoder = geocoder;
        this.nameCache = nameCache;
        this.prefs = prefs;
        this._simple = null;
        this._cancellable = null;
        try {
            this._locationSettings = new Gio.Settings({schema_id: 'org.gnome.system.location'});
        } catch (_e) {
            this._locationSettings = null;
        }
    }

    destroy() {
        this._cancellable?.cancel();
        this._simple = null;
    }

    /** Whether the system-wide Location Services toggle is on. */
    get systemLocationEnabled() {
        return this._locationSettings ? this._locationSettings.get_boolean('enabled') : true;
    }

    /**
     * A one-shot coordinate fix: GeoClue first (prompting once via the Shell
     * agent), then the IP fallback if allowed. Throws LocationError('denied')
     * when neither is available, 'noFix' on a transient failure.
     * @returns {Promise<{latitude:number, longitude:number, source:'geoclue'|'ip', name?:string, countryCode?:string}>}
     */
    async requestFix() {
        let geoclueError = null;
        if (this.systemLocationEnabled) {
            try {
                const fix = await this._geoclueFix();
                return {...fix, source: 'geoclue'};
            } catch (e) {
                geoclueError = e;
            }
        }

        if (this.prefs.ipLocationFallback) {
            try {
                const ip = await this.geocoder.locateByIP();
                if (ip) return {...ip, source: 'ip'};
            } catch (e) {
                // Network down: transient, not a denial — retry next refresh.
                if (!geoclueError || geoclueError.kind === 'noFix')
                    throw new LocationError('noFix', e.message);
            }
        }

        if (geoclueError) throw geoclueError;
        throw new LocationError('denied', 'Location Services are off');
    }

    async _geoclueFix() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        // A cold GeoClue fix (agent dialog + network lookup) can take a while;
        // cap it so a stuck daemon can't wedge the refresh cycle.
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 45, () => {
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        try {
            const simple = await Geoclue.Simple.new(GEOCLUE_DESKTOP_ID, Geoclue.AccuracyLevel.CITY, cancellable);
            this._simple = simple;
            const location = simple.get_location();
            if (!location) throw new LocationError('noFix', 'GeoClue returned no location');
            return {latitude: location.latitude, longitude: location.longitude};
        } catch (e) {
            if (e instanceof LocationError) throw e;
            const msg = e.message ?? String(e);
            // Agent denial / disabled service surface as AccessDenied; anything
            // else (daemon missing, cancelled by our timeout) is transient.
            if (/denied|not allowed|disabled/i.test(msg))
                throw new LocationError('denied', msg);
            throw new LocationError('noFix', msg);
        } finally {
            GLib.source_remove(timeoutId);
            if (this._cancellable === cancellable) this._cancellable = null;
            // Drop the client so GeoClue stops tracking between refreshes.
            this._simple = null;
        }
    }

    /**
     * Coordinate → display name + ISO country code, via the 24 h cell cache
     * then BigDataCloud, falling back to the last cached name.
     * @returns {Promise<{name:string|null, countryCode:string|null}>}
     */
    async resolvePlace(latitude, longitude) {
        const fresh = this.nameCache.name(latitude, longitude);
        if (fresh) return {name: fresh, countryCode: null};
        try {
            const r = await this.geocoder.reverseGeocode(latitude, longitude);
            const name = bdcResolvedName(r);
            if (name) {
                this.nameCache.store(name, latitude, longitude);
                return {name, countryCode: r.countryCode ?? null};
            }
            return {name: this.nameCache.lastKnownName(latitude, longitude), countryCode: r.countryCode ?? null};
        } catch (_e) {
            return {name: this.nameCache.lastKnownName(latitude, longitude), countryCode: null};
        }
    }
}
