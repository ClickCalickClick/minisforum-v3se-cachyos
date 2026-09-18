import GLib from 'gi://GLib';

import {UnitsInfo} from '../weathercore/models.js';

/**
 * Render-time formatting (WeatherFormatting.swift). All wall-clock times are
 * shown in the *location's* timezone (utcOffsetSeconds), never the machine's.
 * `use24h` comes from PrefsStore.uses24HourClock.
 */
export const Fmt = {
    /** "68°" */
    temperature(value) {
        return `${Math.round(value)}°`;
    },

    /** "16 mph W" */
    wind(snapshot) {
        return `${Math.round(snapshot.windSpeed)} ${UnitsInfo.windSpeedLabel(snapshot.unitsUsed)} ${snapshot.windDirection}`;
    },

    /** "Rain now" / "Rain in ~45 min" / "Rain in ~2 hr", or null. */
    rainPill(minutes) {
        if (minutes === null || minutes === undefined) return null;
        if (minutes <= 15) return 'Rain now';
        if (minutes < 60) return `Rain in ~${minutes} min`;
        const hours = Math.floor(minutes / 60);
        return hours === 1 ? 'Rain in ~1 hr' : `Rain in ~${hours} hr`;
    },

    /** "Updated just now" / "Updated 8m ago" / "Updated 2h ago". */
    updatedAgo(fetchedAt, now = Date.now() / 1000) {
        const seconds = Math.max(0, now - fetchedAt);
        if (seconds < 60) return 'Updated just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `Updated ${minutes}m ago`;
        return `Updated ${Math.floor(seconds / 3600)}h ago`;
    },

    _dt(seconds, utcOffsetSeconds) {
        return GLib.DateTime.new_from_unix_utc(Math.floor(seconds)).to_timezone(GLib.TimeZone.new_offset(utcOffsetSeconds));
    },

    /** "6:14 AM" / "18:14" in the location's timezone. */
    clock(seconds, utcOffsetSeconds, use24h) {
        return this._dt(seconds, utcOffsetSeconds).format(use24h ? '%H:%M' : '%-l:%M %p');
    },

    /** "3 PM" / "15" for the hourly strip. */
    hourLabel(seconds, utcOffsetSeconds, use24h) {
        return this._dt(seconds, utcOffsetSeconds).format(use24h ? '%H' : '%-l %p');
    },

    /** "SAT" in the location's timezone. */
    weekday(seconds, utcOffsetSeconds) {
        return this._dt(seconds, utcOffsetSeconds).format('%a').toUpperCase();
    },

    /** "Jul 18, 11:15 AM" for alert effective/expiry stamps. */
    dateTime(seconds, utcOffsetSeconds, use24h) {
        return this._dt(seconds, utcOffsetSeconds).format(use24h ? '%b %-d, %H:%M' : '%b %-d, %-l:%M %p');
    },
};
