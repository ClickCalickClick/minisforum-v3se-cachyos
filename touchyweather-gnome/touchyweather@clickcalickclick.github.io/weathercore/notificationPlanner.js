import GLib from 'gi://GLib';

import {Severity} from './models.js';

/** User-configurable notification triggers (spec.md US-6). */
export function makeNotificationSettings({
    rainEnabled = false, rainLeadMinutes = 30,
    uvEnabled = false, uvThreshold = 8,
    alertEnabled = false, alertMinSeverity = Severity.SEVERE,
} = {}) {
    return {rainEnabled, rainLeadMinutes, uvEnabled, uvThreshold, alertEnabled, alertMinSeverity};
}

export function anyNotificationEnabled(s) {
    return s.rainEnabled || s.uvEnabled || s.alertEnabled;
}

/** The snapshot's local time zone: the named zone when known, else its fixed offset. */
export function snapshotTimeZone(snapshot) {
    if (snapshot.timezoneIdentifier) {
        const tz = GLib.TimeZone.new_identifier(snapshot.timezoneIdentifier);
        if (tz) return tz;
    }
    return GLib.TimeZone.new_offset(snapshot.utcOffsetSeconds ?? 0);
}

function inZone(seconds, tz) {
    return GLib.DateTime.new_from_unix_utc(Math.floor(seconds)).to_timezone(tz);
}

/**
 * Pure evaluation of the three US-6 triggers against one snapshot
 * (NotificationPlanner.swift). Deterministic in (snapshot, settings, state, now).
 * `formatHour(seconds)` renders the rain body's hour in the user's clock format.
 * @returns {{fired: {kind, dedupKey, title, body}[], state}}
 */
export function planNotifications({snapshot, settings, state, now, formatHour = null}) {
    const fired = [];
    const loc = snapshot.location.id;
    const tz = snapshotTimeZone(snapshot);

    // 1. Rain soon — one per rain event, keyed on the predicted start hour.
    if (settings.rainEnabled && snapshot.rainAlertMinutes !== null && snapshot.rainAlertMinutes !== undefined &&
        snapshot.rainAlertMinutes <= settings.rainLeadMinutes) {
        const minutes = snapshot.rainAlertMinutes;
        const nowDT = inZone(now, tz);
        const hourStart = GLib.DateTime.new(tz, nowDT.get_year(), nowDT.get_month(), nowDT.get_day_of_month(), nowDT.get_hour(), 0, 0);
        const hourOffset = minutes <= 15 ? 0 : Math.floor(minutes / 60);
        const startHour = hourStart.add_hours(hourOffset);
        const key = `rain:${loc}:${startHour.format('%Y-%m-%dT%H')}`;
        if (!state.has(key)) {
            state.record(key, now);
            let body;
            if (minutes <= 15) {
                body = 'Rain is starting now.';
            } else {
                const h = formatHour ? formatHour(startHour.to_unix()) : startHour.format('%-l %p');
                body = `Rain likely around ${h}.`;
            }
            fired.push({kind: 'rain', dedupKey: key, title: 'Rain expected soon', body});
        }
    }

    // 2. High UV — once per location per calendar day, before solar noon.
    if (settings.uvEnabled && snapshot.uvMax !== null && snapshot.uvMax !== undefined &&
        snapshot.uvMax >= settings.uvThreshold && isBeforeSolarNoon(snapshot, now, tz)) {
        const key = `uv:${loc}:${inZone(now, tz).format('%Y-%m-%d')}`;
        if (!state.has(key)) {
            state.record(key, now);
            fired.push({
                kind: 'uv', dedupKey: key,
                title: 'High UV today',
                body: `The UV index reaches ${snapshot.uvMax} today — wear sunscreen and cover up.`,
            });
        }
    }

    // 3. Severe alerts — once per NWS alert id, ever.
    if (settings.alertEnabled) {
        for (const alert of snapshot.alerts ?? []) {
            if (alert.severity < settings.alertMinSeverity) continue;
            const key = `alert:${alert.id}`;
            if (!state.has(key)) {
                state.record(key, now);
                fired.push({
                    kind: 'alert', dedupKey: key,
                    title: alert.event,
                    body: alert.headline ?? alert.details ?? 'A severe weather alert is in effect for your area.',
                });
            }
        }
    }

    state.prune(now);
    return {fired, state};
}

function isBeforeSolarNoon(snapshot, now, tz) {
    if (snapshot.sunrise !== null && snapshot.sunrise !== undefined &&
        snapshot.sunset !== null && snapshot.sunset !== undefined)
        return now < (snapshot.sunrise + snapshot.sunset) / 2;
    return inZone(now, tz).get_hour() < 12;
}
