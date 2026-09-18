import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cairo from 'cairo';

import {RadarTileMath} from '../weathercore/radarTileMath.js';
import {RadarTileURLs} from '../weathercore/radarTileUrls.js';
import {ensureDir} from '../weathercore/persistence.js';

const SIZE = RadarTileMath.outputSize;

/**
 * Fetches Carto + RainViewer tiles directly from their public CDNs and
 * composites them on-device with Cairo (RadarRenderer.swift): a darkened
 * basemap, a label overlay drawn above the radar, and transparent radar
 * frames to animate between. Tiles are cached on disk (~/.cache/touchyweather/
 * tiles); Carto tiles for a week, RainViewer frames (immutable per path) for
 * a few hours.
 * @typedef {{base: Cairo.ImageSurface, labels: Cairo.ImageSurface, frames: {time:number, overlay: Cairo.ImageSurface}[]}} RenderedRadar
 */
export class RadarRenderer {
    constructor({http, rainViewer, cacheDir}) {
        this.http = http;
        this.rainViewer = rainViewer;
        this.cacheDir = GLib.build_filenamev([cacheDir, 'tiles']);
        ensureDir(this.cacheDir);
        this._purge();
    }

    /**
     * Throws (→ "Radar unavailable") if the manifest fails or the basemap is
     * blank. `style` picks the dark or light gray canvas to match the Shell.
     */
    async render(latitude, longitude, cancellable = null, style = 'dark') {
        const frameSet = await this.rainViewer.frames();
        const basePlan = RadarTileMath.basePlan(latitude, longitude, RadarTileMath.outputSize, RadarTileURLs.basemapZoom);
        const radarPlan = RadarTileMath.radarPlan(latitude, longitude);

        const [base, labels, frames] = await Promise.all([
            this._renderBase(basePlan, style, cancellable),
            this._renderLabels(basePlan, style, cancellable),
            this._renderFrames(frameSet, radarPlan, cancellable),
        ]);
        if (!base) throw new Error('basemap produced no imagery');
        return {base, labels: labels ?? RadarRenderer._blank(), frames};
    }

    // ---- layers ----

    async _renderBase(plan, style, cancellable) {
        const paths = await this._fetchTiles(plan.placements.map(p => ['base', RadarTileURLs.basemap(plan.zoom, p.tileX, p.tileY, style)]), cancellable);
        const surface = RadarRenderer._blank();
        const cr = new Cairo.Context(surface);
        // The gray canvas is already muted (it's designed as a data backdrop),
        // so the Mac's 72 %-brightness darkening of Carto Voyager isn't needed.
        const drewAny = RadarRenderer._paintTiles(cr, plan, paths, {filter: Cairo.Filter.GOOD});
        cr.$dispose();
        return drewAny ? surface : null;
    }

    async _renderLabels(plan, style, cancellable) {
        const paths = await this._fetchTiles(plan.placements.map(p => ['labels', RadarTileURLs.labels(plan.zoom, p.tileX, p.tileY, style)]), cancellable);
        const surface = RadarRenderer._blank();
        const cr = new Cairo.Context(surface);
        RadarRenderer._paintTiles(cr, plan, paths, {filter: Cairo.Filter.GOOD});
        cr.$dispose();
        return surface;
    }

    async _renderFrames(frameSet, plan, cancellable) {
        // Frames render concurrently; result order follows the manifest
        // (oldest-first) so the scrubber advances forward in time.
        return Promise.all(frameSet.frames.map(async frame => {
            const paths = await this._fetchTiles(plan.placements.map(p =>
                ['radar', RadarTileURLs.radar(frameSet.host, frame.path, plan.zoom, p.tileX, p.tileY)]), cancellable);
            const overlay = RadarRenderer._blank();
            const cr = new Cairo.Context(overlay);
            // z7 tiles upsample ~8× to 1024; bilinear keeps the blobs smooth.
            RadarRenderer._paintTiles(cr, plan, paths, {filter: Cairo.Filter.BILINEAR, minBytes: RadarTileURLs.radarPlaceholderMaxBytes});
            cr.$dispose();
            return {time: frame.time, overlay};
        }));
    }

    // ---- tile fetching (disk-cached) ----

    _tilePath(kind, url) {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        return GLib.build_filenamev([this.cacheDir, `${kind}-${hash}.png`]);
    }

    /** Fetch tiles concurrently, preserving order; a failed tile is null (a gap). */
    _fetchTiles(entries, cancellable) {
        return Promise.all(entries.map(async ([kind, url]) => {
            const path = this._tilePath(kind, url);
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
            try {
                const data = await this.http.getBytes(url, {}, cancellable);
                RadarRenderer._storeAsPNG(data, path);
                return path;
            } catch (_e) {
                return null;
            }
        }));
    }

    /** Drop stale tiles: radar frames after 3 h, basemap/labels after 7 days. */
    _purge() {
        try {
            const dir = Gio.File.new_for_path(this.cacheDir);
            const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const now = Date.now() / 1000;
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                const age = now - info.get_modification_date_time().to_unix();
                const limit = name.startsWith('radar-') ? 3 * 3600 : 7 * 86400;
                if (age > limit) {
                    try {
                        dir.get_child(name).delete(null);
                    } catch (_e) { /* ignore */ }
                }
            }
            en.close(null);
        } catch (_e) {
            // cache dir unreadable — nothing to purge
        }
    }

    /**
     * Cairo only loads PNG; Esri's base tiles are JPEG. Anything that isn't a
     * PNG is decoded with GdkPixbuf and re-encoded once, at cache time.
     */
    static _storeAsPNG(data, path) {
        const isPNG = data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
        if (isPNG) {
            GLib.file_set_contents(path, data);
            return;
        }
        const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(data));
        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
        stream.close(null);
        pixbuf.savev(path, 'png', [], []);
    }

    // ---- Cairo helpers ----

    static _blank() {
        return new Cairo.ImageSurface(Cairo.Format.ARGB32, SIZE, SIZE);
    }

    static _fileSize(path) {
        try {
            return Gio.File.new_for_path(path).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        } catch (_e) {
            return 0;
        }
    }

    /** Paint each cached tile into its placement rect. Returns whether any tile drew. */
    static _paintTiles(cr, plan, paths, {filter, minBytes = 0}) {
        let drewAny = false;
        plan.placements.forEach((p, i) => {
            const path = paths[i];
            if (!path) return;
            // RainViewer serves a tiny placeholder PNG (HTTP 200) for
            // unsupported/empty areas; treat it as no precipitation.
            if (minBytes && RadarRenderer._fileSize(path) <= minBytes) return;
            let tile;
            try {
                tile = Cairo.ImageSurface.createFromPNG(path);
            } catch (_e) {
                return;   // not a PNG (error page) → gap
            }
            const tileWidth = tile.getWidth?.() || RadarTileMath.tilePixels;
            const scale = p.destSize / tileWidth;
            cr.save();
            cr.translate(p.destX, p.destY);
            cr.scale(scale, scale);
            const pattern = new Cairo.SurfacePattern(tile);
            pattern.setFilter(filter);
            cr.setSource(pattern);
            cr.rectangle(0, 0, tileWidth, tileWidth);
            cr.fill();
            cr.restore();
            drewAny = true;
        });
        return drewAny;
    }
}
