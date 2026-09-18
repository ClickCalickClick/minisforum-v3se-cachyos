import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {HttpClient} from './weathercore/http.js';
import {CachePolicy} from './weathercore/cachePolicy.js';
import {WeatherService} from './weathercore/weatherService.js';
import {OpenMeteoForecastClient} from './weathercore/providers/forecast.js';
import {OpenMeteoAirQualityClient} from './weathercore/providers/airQuality.js';
import {OpenMeteoGeocodingClient} from './weathercore/providers/geocoding.js';
import {BigDataCloudGeocoder} from './weathercore/providers/bigDataCloud.js';
import {NWSAlertsClient} from './weathercore/providers/nws.js';
import {ProxyClient} from './weathercore/providers/proxy.js';
import {RainViewerClient} from './weathercore/providers/rainviewer.js';
import {
    SnapshotCache, LocationsFileStore, GeocodeCache, NotificationStateStore,
    defaultDataDir, defaultCacheDir, ensureDir,
} from './weathercore/persistence.js';

import {PrefsStore} from './app/prefsStore.js';
import {resolveProxyKey} from './app/secrets.js';
import {LocationService} from './app/locationService.js';
import {LocationStore} from './app/locationStore.js';
import {WeatherStore} from './app/weatherStore.js';
import {RefreshScheduler} from './app/refreshScheduler.js';
import {NotificationEngine} from './app/notificationEngine.js';
import {AnalyticsService} from './app/analytics.js';
import {RadarRenderer} from './app/radarRenderer.js';
import {RadarCard} from './app/ui/radarCard.js';
import {Popover} from './app/ui/popover.js';
import {TouchyWeatherButton} from './app/ui/panelButton.js';
import {DevScreenshots} from './app/devScreenshots.js';

/**
 * TouchyWeather for GNOME — the extension IS the app (TouchyWeatherApp.swift):
 * a top-bar item with the condition glyph + temperature, and a card popover.
 * Everything is built in enable() and torn down in disable().
 */
export default class TouchyWeatherExtension extends Extension {
    enable() {
        const version = this.metadata['version-name'] ?? 'dev';
        const userAgent = `TouchyWeatherGNOME/${version} (jwuerz@gmail.com)`;
        const dataDir = defaultDataDir();
        const cacheDir = defaultCacheDir();
        ensureDir(dataDir);
        ensureDir(cacheDir);

        this._prefs = new PrefsStore(this.getSettings());

        // One session per timeout class (JSON 15 s, alerts 6 s, imagery 25 s).
        this._http = new HttpClient({timeout: CachePolicy.httpTimeout, userAgent});
        this._alertsHttp = new HttpClient({timeout: CachePolicy.alertsTimeout, userAgent});
        this._imageHttp = new HttpClient({timeout: CachePolicy.imageTimeout, userAgent});

        const proxyKey = resolveProxyKey(this._prefs);
        const proxy = proxyKey ? new ProxyClient(this._http, proxyKey) : null;

        this._service = new WeatherService({
            forecastClient: new OpenMeteoForecastClient(this._http),
            airQualityClient: new OpenMeteoAirQualityClient(this._http),
            proxyClient: proxy,
            alertsProvider: new NWSAlertsClient(this._alertsHttp, version),
            cache: new SnapshotCache(dataDir),
        });

        const geocoder = new BigDataCloudGeocoder(this._http);
        this._locationService = new LocationService({geocoder, nameCache: new GeocodeCache(dataDir), prefs: this._prefs});
        this._locations = new LocationStore({fileStore: new LocationsFileStore(dataDir), service: this._locationService, prefs: this._prefs});

        this._notifications = new NotificationEngine({
            stateStore: new NotificationStateStore(dataDir),
            prefs: this._prefs,
            onOpenRequested: () => this._button?.openMenu(),
        });
        const analytics = proxy ? new AnalyticsService({proxy, prefs: this._prefs}) : null;
        this._weather = new WeatherStore({service: this._service, prefs: this._prefs, locationStore: this._locations, analytics, notifications: this._notifications});

        this._radarRenderer = new RadarRenderer({http: this._imageHttp, rainViewer: new RainViewerClient(this._http), cacheDir});
        this._radarCard = new RadarCard({renderer: this._radarRenderer, weatherStore: this._weather, ctx: {prefs: this._prefs, get use24h() { return this.prefs.uses24HourClock; }}});

        this._popover = new Popover({
            weatherStore: this._weather,
            locationStore: this._locations,
            prefs: this._prefs,
            radarCard: this._radarCard,
            geocodingClient: new OpenMeteoGeocodingClient(this._http),
            notifications: this._notifications,
            onOpenPrefs: () => {
                this._button?.menu.close();
                this.openPreferences();
            },
            onQuit: () => this._quit(),
            onRefresh: () => this._scheduler?.tick(true),
        });

        this._button = new TouchyWeatherButton();
        this._button.menu.addMenuItem(this._popover.menuSection);
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            this._popover.setOpen(open);
            // Popover-open trigger: gated refresh (no-op if fresh).
            if (open) this._weather.refresh(false);
        });
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

        this._weatherChangedId = this._weather.changed.connect(() => this._onStateChanged());
        this._locationsChangedId = this._locations.changed.connect(() => this._onStateChanged());
        this._prefsChangedId = this._prefs.changed.connect(key => this._onPrefChanged(key));

        this._scheduler = new RefreshScheduler({store: this._weather, locations: this._locations});
        this._scheduler.start();
        this._onStateChanged();

        this._dev = DevScreenshots.maybeStart(this);
    }

    disable() {
        this._dev?.destroy();
        this._dev = null;
        this._scheduler?.destroy();
        this._scheduler = null;
        if (this._weatherChangedId) this._weather.changed.disconnect(this._weatherChangedId);
        if (this._locationsChangedId) this._locations.changed.disconnect(this._locationsChangedId);
        if (this._prefsChangedId) this._prefs.changed.disconnect(this._prefsChangedId);
        this._weatherChangedId = this._locationsChangedId = this._prefsChangedId = 0;
        this._popover?.destroy();
        this._popover = null;
        this._radarCard?.destroy();
        this._radarCard = null;
        this._button?.destroy();
        this._button = null;
        this._notifications?.destroy();
        this._notifications = null;
        this._locationService?.destroy();
        this._locationService = null;
        for (const http of [this._http, this._alertsHttp, this._imageHttp]) http?.abort();
        this._http = this._alertsHttp = this._imageHttp = null;
        this._prefs?.destroy();
        this._prefs = null;
        this._service = this._locations = this._weather = this._radarRenderer = null;
    }

    _onStateChanged() {
        if (!this._button) return;
        this._button.update(this._weather.activeSnapshot, this._prefs.menuBarStyle);
        if (this._button.menu.isOpen) this._popover.queueRender();
    }

    _onPrefChanged(key) {
        if (!this._button) return;
        if (key === 'units') {
            // A unit change forces an immediate refresh (US-7).
            this._weather.refresh(true);
            return;
        }
        this._onStateChanged();
    }

    /** The Mac's quit button ⇒ disable the extension. */
    _quit() {
        this._button?.menu.close();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.extensionManager.disableExtension(this.uuid);
            return GLib.SOURCE_REMOVE;
        });
    }
}
