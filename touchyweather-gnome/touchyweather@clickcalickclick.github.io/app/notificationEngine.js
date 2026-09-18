import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {planNotifications, anyNotificationEnabled} from '../weathercore/notificationPlanner.js';
import {Fmt} from './formatting.js';

/**
 * Delivers the three US-6 triggers (NotificationEngine.swift) through the
 * Shell's message tray. GNOME needs no authorization step; the tray honors Do
 * Not Disturb itself. The decision + dedup live in the pure planner; this owns
 * the persisted ledger and the Source, and opens the popover on click.
 */
export class NotificationEngine {
    constructor({stateStore, prefs, onOpenRequested}) {
        this.stateStore = stateStore;
        this.prefs = prefs;
        this.onOpenRequested = onOpenRequested;
        this._source = null;
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
    }

    /** Evaluate the triggers for a fresh snapshot and post what fires. */
    async evaluate(snapshot, settings) {
        if (!anyNotificationEnabled(settings)) return;
        const state = this.stateStore.load();
        const result = planNotifications({
            snapshot, settings, state, now: Date.now() / 1000,
            formatHour: s => Fmt.hourLabel(s, snapshot.utcOffsetSeconds, this.prefs.uses24HourClock),
        });
        for (const note of result.fired) this.post(note);
        try {
            this.stateStore.save(result.state);
        } catch (e) {
            console.error(`TouchyWeather: notification state save failed: ${e.message}`);
        }
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'TouchyWeather', iconName: 'weather-few-clouds-symbolic'});
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    post(note) {
        const iconName = {rain: 'weather-showers-symbolic', uv: 'weather-clear-symbolic', alert: 'weather-severe-alert-symbolic'}[note.kind] ?? 'weather-few-clouds-symbolic';
        const notification = new MessageTray.Notification({
            source: this._getSource(),
            title: note.title,
            body: note.body,
            iconName,
            urgency: note.kind === 'alert' ? MessageTray.Urgency.HIGH : MessageTray.Urgency.NORMAL,
        });
        notification.connect('activated', () => this.onOpenRequested?.());
        this._getSource().addNotification(notification);
    }

    /** Debug: post an immediate test notification (click → popover opens). */
    debugSendTestNotification() {
        this.post({kind: 'alert', dedupKey: `debug-${Date.now()}`, title: 'TouchyWeather test', body: 'Click me — the popover should open.'});
    }
}
