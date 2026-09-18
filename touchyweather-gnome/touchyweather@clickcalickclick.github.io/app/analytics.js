import GLib from 'gi://GLib';

import {uuid} from '../weathercore/models.js';

/**
 * Anonymous active-user ping (AnalyticsService.swift): at most one POST per
 * UTC day, the day marked done only on 2xx, opt-out honored before any request
 * is constructed. Device id + last-ping day live in GSettings.
 */
export class AnalyticsService {
    constructor({proxy, prefs, today = AnalyticsService.utcDayString}) {
        this.proxy = proxy;
        this.prefs = prefs;
        this.today = today;
    }

    async pingIfNeeded(latitude, longitude) {
        if (!this.prefs.analyticsEnabled) return;
        const day = this.today();
        if (this.prefs.analyticsLastPingDay === day) return;
        try {
            await this.proxy.track(this._deviceID(), latitude, longitude);
            this.prefs.analyticsLastPingDay = day;
        } catch (e) {
            console.debug?.(`TouchyWeather: analytics ping failed: ${e.message}`);
        }
    }

    _deviceID() {
        let id = this.prefs.analyticsDeviceID;
        if (!id) {
            id = uuid();
            this.prefs.analyticsDeviceID = id;
        }
        return id;
    }

    static utcDayString() {
        return GLib.DateTime.new_now_utc().format('%Y-%m-%d');
    }
}
