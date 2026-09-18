import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Funnels every refresh trigger into WeatherStore.refresh() (RefreshScheduler
 * .swift): a 15-min tick, resume from suspend (logind PrepareForSleep), network
 * restoration (Gio.NetworkMonitor), and the initial launch load. The
 * popover-open trigger lives in the panel button; manual refresh is the footer.
 */
export class RefreshScheduler {
    constructor({store, locations}) {
        this.store = store;
        this.locations = locations;
        this._tickId = 0;
        this._sleepSubId = 0;
        this._netId = 0;
        this._lastAvailable = true;
        this._destroyed = false;
    }

    start() {
        this.store.loadCachedSnapshots();
        this.tick();

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15 * 60, () => {
            this.tick();
            return GLib.SOURCE_CONTINUE;
        });

        this._sleepSubId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1', 'org.freedesktop.login1.Manager', 'PrepareForSleep',
            '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [sleeping] = params.deepUnpack();
                if (!sleeping) {
                    // Give the network a beat to come back after resume.
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                        if (!this._destroyed) this.tick();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });

        const monitor = Gio.NetworkMonitor.get_default();
        this._lastAvailable = monitor.network_available;
        this._netId = monitor.connect('network-changed', (_m, available) => {
            if (available && !this._lastAvailable) this.tick();
            this._lastAvailable = available;
        });
    }

    /** One refresh cycle: fresh Current-Location fix, then the active weather. */
    async tick(force = false) {
        if (this._destroyed) return;
        try {
            await this.locations.updateCurrentLocation();
            if (this._destroyed) return;
            await this.store.refresh(force);
        } catch (e) {
            console.error(`TouchyWeather: refresh cycle failed: ${e.message}\n${e.stack}`);
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._tickId) GLib.source_remove(this._tickId);
        this._tickId = 0;
        if (this._sleepSubId) Gio.DBus.system.signal_unsubscribe(this._sleepSubId);
        this._sleepSubId = 0;
        if (this._netId) Gio.NetworkMonitor.get_default().disconnect(this._netId);
        this._netId = 0;
    }
}
