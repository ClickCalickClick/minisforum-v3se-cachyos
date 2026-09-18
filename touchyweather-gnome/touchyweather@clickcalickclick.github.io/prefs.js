import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * The preferences window (SettingsView.swift, spec.md US-7): General (units,
 * main card, top bar style, time format, notifications, analytics, location
 * fallback, proxy key) and About (version + data-source attributions).
 */
export default class TouchyWeatherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(480, 720);
        window.add(this._generalPage(settings));
        window.add(this._aboutPage());
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        // Units
        const units = new Adw.PreferencesGroup({title: 'Units', description: 'Changing units re-fetches immediately — Open-Meteo converts server-side.'});
        units.add(this._combo(settings, 'units', 'Measurement', ['Imperial (°F, mph)', 'Metric (°C, km/h)']));
        page.add(units);

        // Main card / top bar
        const main = new Adw.PreferencesGroup({title: 'Main Card &amp; Top Bar'});
        main.add(this._combo(settings, 'show-dew-point', 'Humidity display', ['Humidity', 'Dew point'], {boolean: true}));
        main.add(this._combo(settings, 'menu-bar-style', 'Top bar style', ['Icon & temperature', 'Icon only', 'Temperature only']));
        page.add(main);

        // Time format
        const time = new Adw.PreferencesGroup({title: 'Time Format'});
        time.add(this._combo(settings, 'time-format', 'Clock', ['Match system', '12-hour', '24-hour']));
        page.add(time);

        // Notifications
        const notif = new Adw.PreferencesGroup({title: 'Notifications', description: 'All off by default. Severe-weather alerts are US only (NWS) — elsewhere there is no banner and no notification.'});
        const rain = this._switch(settings, 'notify-rain-enabled', 'Rain starting soon');
        const rainLead = this._combo(settings, 'notify-rain-lead-minutes', 'Lead time', ['15 minutes', '30 minutes', '60 minutes'], {values: [15, 30, 60]});
        notif.add(rain);
        notif.add(rainLead);
        const uv = this._switch(settings, 'notify-uv-enabled', 'High UV index', 'At most once a day, in the morning.');
        const uvAt = this._combo(settings, 'notify-uv-threshold', 'Notify at', ['UV 6 (High)', 'UV 8 (Very High)', 'UV 11 (Extreme)'], {values: [6, 8, 11]});
        notif.add(uv);
        notif.add(uvAt);
        const alert = this._switch(settings, 'notify-alert-enabled', 'Severe weather alerts');
        const moderate = this._switch(settings, 'notify-alert-include-moderate', 'Include moderate alerts');
        notif.add(alert);
        notif.add(moderate);
        const syncSensitivity = () => {
            rainLead.sensitive = settings.get_boolean('notify-rain-enabled');
            uvAt.sensitive = settings.get_boolean('notify-uv-enabled');
            moderate.sensitive = settings.get_boolean('notify-alert-enabled');
        };
        settings.connect('changed', syncSensitivity);
        syncSensitivity();
        page.add(notif);

        // General
        const general = new Adw.PreferencesGroup({title: 'General'});
        general.add(this._switch(settings, 'ip-location-fallback', 'Approximate location from IP address',
            'Used only when Location Services are off or deny access. City-level accuracy; the request goes to BigDataCloud.'));
        general.add(this._switch(settings, 'analytics-enabled', 'Share anonymous usage analytics',
            'Aggregate active-user counts only — no account, no precise location. On by default; turn off to send nothing.'));
        const key = new Adw.PasswordEntryRow({title: 'Proxy key'});
        key.text = settings.get_string('proxy-key');
        key.connect('changed', () => settings.set_string('proxy-key', key.text));
        general.add(key);
        const keyNote = new Adw.ActionRow({
            title: 'Optional: unlocks pollen outside Europe and the analytics ping (the TouchyWeather Vercel proxy). Also read from TW_PROXY_KEY or ~/.config/touchyweather/secrets.json.',
            subtitle_lines: 0,
        });
        keyNote.add_css_class('dim-label');
        general.add(keyNote);
        page.add(general);

        // Location Services shortcut
        const loc = new Adw.PreferencesGroup({title: 'Location'});
        const row = new Adw.ActionRow({title: 'Location Services', subtitle: 'The current-location entry uses GeoClue. Grant or revoke access in Settings → Privacy &amp; Security → Location.'});
        const open = new Gtk.Button({label: 'Open Settings', valign: Gtk.Align.CENTER});
        open.connect('clicked', () => {
            try {
                Gio.AppInfo.create_from_commandline('gnome-control-center location', null, Gio.AppInfoCreateFlags.NONE).launch([], null);
            } catch (e) {
                console.error(e.message);
            }
        });
        row.add_suffix(open);
        loc.add(row);
        page.add(loc);

        return page;
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
        const about = new Adw.PreferencesGroup();
        const header = new Adw.ActionRow({
            title: 'TouchyWeather for GNOME',
            subtitle: `Version ${this.metadata['version-name'] ?? 'dev'} — the GNOME Shell port of TouchyWeather for Mac, companion to the TouchyWeather Pebble app.`,
            subtitle_lines: 0,
        });
        header.add_prefix(new Gtk.Image({icon_name: 'weather-few-clouds-symbolic', pixel_size: 40}));
        about.add(header);
        page.add(about);

        const sources = new Adw.PreferencesGroup({title: 'Data Sources'});
        const add = (label, name, url) => {
            const r = new Adw.ActionRow({title: label, subtitle: name, activatable: true});
            r.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
            r.connect('activated', () => Gio.AppInfo.launch_default_for_uri_async(url, null, null, null));
            sources.add(r);
        };
        add('Weather', 'Open-Meteo (CC BY 4.0)', 'https://open-meteo.com');
        add('Reverse geocoding', 'BigDataCloud', 'https://www.bigdatacloud.com');
        add('Radar', 'RainViewer', 'https://www.rainviewer.com');
        add('Basemap', 'Esri, HERE, Garmin, © OpenStreetMap contributors (Gray Canvas)', 'https://www.esri.com/en-us/legal/terms/data-attributions');
        add('Alerts', 'NWS / NOAA (public domain)', 'https://www.weather.gov');
        add('Pollen', 'Google', 'https://developers.google.com/maps/documentation/pollen');
        page.add(sources);

        const project = new Adw.PreferencesGroup({title: 'Project'});
        const repo = new Adw.ActionRow({title: 'Source code', subtitle: this.metadata.url, activatable: true});
        repo.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
        repo.connect('activated', () => Gio.AppInfo.launch_default_for_uri_async(this.metadata.url, null, null, null));
        project.add(repo);
        page.add(project);
        return page;
    }

    // ---- row helpers ----

    _switch(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /**
     * A combo row over an enum / int / boolean key. `values` maps combo index
     * → int for non-enum int keys; `boolean` maps index 0/1 → false/true.
     */
    _combo(settings, key, title, labels, {values = null, boolean = false} = {}) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
        const read = () => {
            if (boolean) return settings.get_boolean(key) ? 1 : 0;
            if (values) return Math.max(0, values.indexOf(settings.get_int(key)));
            return settings.get_enum(key);
        };
        const write = i => {
            if (boolean) settings.set_boolean(key, i === 1);
            else if (values) settings.set_int(key, values[i]);
            else settings.set_enum(key, i);
        };
        row.selected = read();
        let syncing = false;
        row.connect('notify::selected', () => {
            if (syncing) return;
            write(row.selected);
        });
        settings.connect(`changed::${key}`, () => {
            syncing = true;
            row.selected = read();
            syncing = false;
        });
        return row;
    }
}
