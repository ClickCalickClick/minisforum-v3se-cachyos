#!/usr/bin/env -S gjs -m
// Live smoke test: runs the real WeatherService pipeline (Open-Meteo, AQ, NWS,
// RainViewer manifest, BigDataCloud IP geolocation) for one location, with
// persistence in a temp dir. Needs network. Usage: gjs -m gnome/tests/live.js [lat lon]

import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const coreDir = GLib.build_filenamev([here, '..', 'touchyweather@clickcalickclick.github.io', 'weathercore']);
const core = name => import(`file://${coreDir}/${name}`);

const {HttpClient} = await core('http.js');
const {CachePolicy} = await core('cachePolicy.js');
const {WeatherService} = await core('weatherService.js');
const {OpenMeteoForecastClient} = await core('providers/forecast.js');
const {OpenMeteoAirQualityClient} = await core('providers/airQuality.js');
const {NWSAlertsClient} = await core('providers/nws.js');
const {RainViewerClient} = await core('providers/rainviewer.js');
const {BigDataCloudGeocoder, bdcResolvedName} = await core('providers/bigDataCloud.js');
const {OpenMeteoGeocodingClient, geocodingDisplayLabel} = await core('providers/geocoding.js');
const {SnapshotCache, LocationsFile, LocationsFileStore} = await core('persistence.js');
const {makeLocation, LocationKind, conditionDescription, moonDisplayName} = await core('models.js');

const tmp = GLib.dir_make_tmp('tw-live-XXXXXX');
const args = ARGV.map(Number);

// No nested GLib.MainLoop here: under `gjs -m` the runtime already drives the
// main context while a top-level await is pending, and nesting a second loop
// inside that starves the Soup callbacks.
await (async () => {
    try {
        const http = new HttpClient({timeout: CachePolicy.httpTimeout});
        const bdc = new BigDataCloudGeocoder(http);

        let lat = args[0], lon = args[1];
        if (!Number.isFinite(lat)) {
            const ip = await bdc.locateByIP();
            print(`IP geolocation: ${JSON.stringify(ip)}`);
            lat = ip.latitude; lon = ip.longitude;
        }
        const rev = await bdc.reverseGeocode(lat, lon);
        const name = bdcResolvedName(rev) ?? 'Here';
        print(`Reverse geocode: ${name}, ${rev.countryCode}`);

        const store = new LocationsFileStore(tmp);
        const file = store.load();
        file.upsertCurrentLocation({latitude: lat, longitude: lon, name, countryCode: rev.countryCode});
        store.save(file);
        const location = store.load().currentLocation;

        const service = new WeatherService({
            forecastClient: new OpenMeteoForecastClient(http),
            airQualityClient: new OpenMeteoAirQualityClient(http),
            alertsProvider: new NWSAlertsClient(new HttpClient({timeout: CachePolicy.alertsTimeout}), 'live'),
            cache: new SnapshotCache(tmp),
        });
        const t0 = Date.now();
        const s = await service.refresh(location, 0, true);
        print(`Refresh took ${Date.now() - t0} ms`);
        print(`  ${s.location.name}: ${conditionDescription(s.condition)} ${s.temperature}° feels ${s.feelsLike}° hi/lo ${s.high}/${s.low} wind ${s.windSpeed} ${s.windDirection} hum ${s.humidity}% dew ${s.dewPoint}`);
        print(`  precip5 ${JSON.stringify(s.precipProbNext5)} rainAlert ${s.rainAlertMinutes} uv ${s.uv}/${s.uvMax} aqi ${s.aqi} pm25 ${s.pm25} pollen ${s.pollenLevel}`);
        print(`  hourly ${s.hourly.length} daily ${s.daily.length} sunrise ${new Date(s.sunrise * 1000).toISOString()} sunset ${new Date(s.sunset * 1000).toISOString()}`);
        print(`  moon ${moonDisplayName(s.moon)} ${s.moon.illumination}% golden ${JSON.stringify(s.goldenHours)}`);
        print(`  alerts ${s.alerts.length} ${s.alerts.map(a => a.event).join('; ')}`);
        const cached = service.cachedSnapshot(location.id);
        print(`  cache round-trip: ${cached && cached.fetchedAt === s.fetchedAt ? 'ok' : 'MISMATCH'}`);
        const again = await service.refresh(location, 0, false);
        print(`  freshness gate: ${again === cached || again.fetchedAt === s.fetchedAt ? 'served from cache' : 'REFETCHED (bad)'}`);

        const rv = await new RainViewerClient(http).frames();
        print(`RainViewer: host ${rv.host}, ${rv.frames.length} frames, newest ${new Date(rv.frames.at(-1).time * 1000).toISOString()}`);

        const geo = await new OpenMeteoGeocodingClient(http).search('Davenport');
        print(`Geocoding "Davenport": ${geo.slice(0, 3).map(geocodingDisplayLabel).join(' | ')}`);
        print('LIVE OK');
    } catch (e) {
        print(`LIVE FAILED: ${e.message}\n${e.stack}`);
        imports.system.exit(1);
    }
})();
