import Gio from 'gi://Gio';

import {Emitter} from './signals.js';
import {makeNotificationSettings} from '../weathercore/notificationPlanner.js';
import {Severity} from '../weathercore/models.js';

export const MenuBarStyle = Object.freeze({ICON_AND_TEMP: 0, ICON_ONLY: 1, TEMP_ONLY: 2});
export const TimeFormat = Object.freeze({SYSTEM: 0, TWELVE_HOUR: 1, TWENTY_FOUR_HOUR: 2});

/**
 * Flat user preferences over the extension's GSettings (PreferencesStore.swift).
 * `changed` fires with the key name on every change.
 */
export class PrefsStore {
    constructor(settings) {
        this._settings = settings;
        this.changed = new Emitter();
        this._changedId = settings.connect('changed', (_s, key) => this.changed.emit(key));
        // "Match system" follows the GNOME clock-format setting.
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceId = this._interface.connect('changed::clock-format', () => this.changed.emit('time-format'));
    }

    destroy() {
        this._settings.disconnect(this._changedId);
        this._interface.disconnect(this._interfaceId);
        this.changed.clear();
    }

    get units() { return this._settings.get_enum('units'); }
    set units(v) { this._settings.set_enum('units', v); }
    get menuBarStyle() { return this._settings.get_enum('menu-bar-style'); }
    get showDewPoint() { return this._settings.get_boolean('show-dew-point'); }
    get timeFormat() { return this._settings.get_enum('time-format'); }
    get analyticsEnabled() { return this._settings.get_boolean('analytics-enabled'); }
    get ipLocationFallback() { return this._settings.get_boolean('ip-location-fallback'); }
    get proxyKey() { return this._settings.get_string('proxy-key'); }

    /** Resolved 12/24-hour clock, honoring "match system". */
    get uses24HourClock() {
        switch (this.timeFormat) {
        case TimeFormat.TWELVE_HOUR: return false;
        case TimeFormat.TWENTY_FOUR_HOUR: return true;
        default: return this._interface.get_string('clock-format') === '24h';
        }
    }

    get notifyRainEnabled() { return this._settings.get_boolean('notify-rain-enabled'); }
    get notifyRainLeadMinutes() { return this._settings.get_int('notify-rain-lead-minutes'); }
    get notifyUVEnabled() { return this._settings.get_boolean('notify-uv-enabled'); }
    get notifyUVThreshold() { return this._settings.get_int('notify-uv-threshold'); }
    get notifyAlertEnabled() { return this._settings.get_boolean('notify-alert-enabled'); }
    get notifyAlertIncludeModerate() { return this._settings.get_boolean('notify-alert-include-moderate'); }

    /** The pure settings value the notification planner evaluates. */
    get notificationSettings() {
        return makeNotificationSettings({
            rainEnabled: this.notifyRainEnabled,
            rainLeadMinutes: this.notifyRainLeadMinutes,
            uvEnabled: this.notifyUVEnabled,
            uvThreshold: this.notifyUVThreshold,
            alertEnabled: this.notifyAlertEnabled,
            alertMinSeverity: this.notifyAlertIncludeModerate ? Severity.MODERATE : Severity.SEVERE,
        });
    }

    // Internal flags (LocationStore / AnalyticsService state).
    get hasRequestedLocationAuth() { return this._settings.get_boolean('has-requested-location-auth'); }
    set hasRequestedLocationAuth(v) { this._settings.set_boolean('has-requested-location-auth', v); }
    get hasShownDeniedHint() { return this._settings.get_boolean('has-shown-denied-hint'); }
    set hasShownDeniedHint(v) { this._settings.set_boolean('has-shown-denied-hint', v); }
    get analyticsDeviceID() { return this._settings.get_string('analytics-device-id'); }
    set analyticsDeviceID(v) { this._settings.set_string('analytics-device-id', v); }
    get analyticsLastPingDay() { return this._settings.get_string('analytics-last-ping-day'); }
    set analyticsLastPingDay(v) { this._settings.set_string('analytics-last-ping-day', v); }
}
