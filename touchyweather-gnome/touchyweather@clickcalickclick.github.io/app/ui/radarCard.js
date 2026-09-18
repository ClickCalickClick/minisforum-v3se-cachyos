import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Cairo from 'cairo';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {RadarTileMath} from '../../weathercore/radarTileMath.js';
import {RadarTileURLs} from '../../weathercore/radarTileUrls.js';
import {Faults} from '../../weathercore/weatherService.js';
import {Fmt} from '../formatting.js';
import {Opacity, label, icon, hbox, vbox, card, button, drawingArea, foreground, setSource, roundedRect} from './widgets.js';

const MAP_SIZE = 312;              // logical px: 360 root − 2×12 stack − 2×12 card
const FRAME_STEP_MS = 600;
const HOLD_NEWEST_MS = 900;
const RELOAD_AFTER_S = 10 * 60;    // RainViewer publishes a frame every ~10 min

/**
 * Card 9 — Radar (spec.md US-4). A darkened basemap, animated transparent
 * RainViewer overlays at 60 %, labels on top, with play/pause, a scrub slider
 * and the frame timestamp. Keeps its rendered imagery across popover renders
 * (a location switch or stale frames trigger a reload; the disk tile cache
 * makes that cheap).
 */
export class RadarCard {
    constructor({renderer, weatherStore, ctx}) {
        this.renderer = renderer;
        this.weatherStore = weatherStore;
        this.ctx = ctx;
        this._phase = 'idle';           // idle | loading | loaded | failed
        this._rendered = null;
        this._loadedAt = 0;
        this._locationKey = null;
        this._frameIndex = 0;
        this._isPlaying = true;
        this._timerId = 0;
        this._visible = false;
        this._cancellable = null;
        this._snapshot = null;
        this._buildActor();
    }

    get actor() {
        return this._card;
    }

    _buildActor() {
        this._card = card({title: 'Radar', iconName: 'weather-showers-symbolic'});
        this._card.x_expand = true;

        this._map = drawingArea(MAP_SIZE, MAP_SIZE, (cr, w, h, a) => this._paint(cr, w, h, a));
        this._map.x_align = Clutter.ActorAlign.CENTER;
        this._card.add_child(this._map);

        // Overlaid status (loading / unavailable) sits on the map area.
        this._status = vbox({xAlign: Clutter.ActorAlign.CENTER, yAlign: Clutter.ActorAlign.CENTER, style: 'spacing: 6px;'});
        this._statusIcon = icon('content-loading-symbolic', 'tw-placeholder-icon', {opacity: Opacity.secondary});
        this._statusLabel = label('Loading radar…', 'tw-callout', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER});
        this._status.add_child(this._statusIcon);
        this._status.add_child(this._statusLabel);
        const bin = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._card.remove_child(this._map);
        bin.add_child(this._map);
        bin.add_child(this._status);
        this._card.add_child(bin);

        const controls = hbox({styleClass: 'tw-radar-controls', xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        this._playButton = button({iconName: 'media-playback-pause-symbolic', iconClass: 'tw-small-icon', styleClass: 'tw-row-button', tooltip: 'Play/pause', onClick: () => {
            this._isPlaying = !this._isPlaying;
            this._syncControls();
        }});
        controls.add_child(this._playButton);
        this._slider = new Slider(1);
        this._slider.x_expand = true;
        this._slider.connect('notify::value', () => {
            if (this._suppressSlider || !this._rendered) return;
            const n = this._rendered.frames.length;
            const idx = Math.round(this._slider.value * Math.max(n - 1, 1));
            if (idx !== this._frameIndex) {
                this._isPlaying = false;
                this._frameIndex = Math.min(idx, n - 1);
                this._syncControls();
                this._map.queue_repaint();
            }
        });
        controls.add_child(this._slider);
        this._timeLabel = label('—', 'tw-caption tw-mono tw-radar-time', {opacity: Opacity.secondary, align: Clutter.ActorAlign.END});
        controls.add_child(this._timeLabel);
        this._card.add_child(controls);

        // Required source credit (RainViewer's ToS mandates a link back).
        const credit = new St.Button({style_class: 'tw-tiny', x_align: Clutter.ActorAlign.START, can_focus: true});
        credit.set_child(label(RadarTileURLs.attribution, 'tw-tiny', {opacity: Opacity.tertiary}));
        credit.accessible_name = 'Open rainviewer.com';
        credit.connect('clicked', () => Gio.AppInfo.launch_default_for_uri_async('https://www.rainviewer.com/', null, null, null));
        this._card.add_child(credit);

        this._syncControls();
    }

    // ---- public ----

    /** Called on every popover render with the current snapshot. */
    setSnapshot(snapshot) {
        this._snapshot = snapshot;
        if (!snapshot) return;
        const key = `${snapshot.location.id}:${Main.getStyleVariant?.() ?? 'dark'}`;
        const stale = this._phase === 'loaded' && Date.now() / 1000 - this._loadedAt > RELOAD_AFTER_S;
        if (key !== this._locationKey || this._phase === 'idle' || this._phase === 'failed' || stale) {
            const locationChanged = key !== this._locationKey;
            this._locationKey = key;
            this._load(snapshot.location.latitude, snapshot.location.longitude, locationChanged);
        }
        this._syncControls();
    }

    /** Playback runs only while the popover is open. */
    setVisible(visible) {
        this._visible = visible;
        if (visible) this._startTimer();
        else this._stopTimer();
    }

    destroy() {
        this._stopTimer();
        this._cancellable?.cancel();
        this._cancellable = null;
        this._rendered = null;
        this._card.destroy();
    }

    // ---- loading & playback ----

    async _load(latitude, longitude, clearOld) {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._phase = 'loading';
        if (clearOld) {
            this._rendered = null;
            this._frameIndex = 0;
        }
        this._syncStatus();
        if (this.weatherStore.debugFaults & Faults.RADAR) {
            this._phase = 'failed';
            this._rendered = null;
            this._syncStatus();
            this._syncControls();
            this._map.queue_repaint();
            return;
        }
        try {
            const style = Main.getStyleVariant?.() === 'light' ? 'light' : 'dark';
            const rendered = await this.renderer.render(latitude, longitude, cancellable, style);
            if (cancellable.is_cancelled()) return;
            this._rendered = rendered;
            this._loadedAt = Date.now() / 1000;
            this._frameIndex = Math.max(rendered.frames.length - 1, 0);   // start on the newest
            this._phase = 'loaded';
        } catch (e) {
            if (cancellable.is_cancelled()) return;
            console.warn(`TouchyWeather: radar unavailable: ${e.message}`);
            if (!this._rendered) this._phase = 'failed';
            else this._phase = 'loaded';    // keep showing the previous imagery
        } finally {
            if (this._cancellable === cancellable) this._cancellable = null;
        }
        this._syncStatus();
        this._syncControls();
        this._map.queue_repaint();
    }

    _startTimer() {
        if (this._timerId) return;
        const step = () => {
            this._timerId = 0;
            if (!this._visible) return GLib.SOURCE_REMOVE;
            let delay = FRAME_STEP_MS;
            if (this._isPlaying && this._rendered && this._rendered.frames.length > 1) {
                if (this._frameIndex >= this._rendered.frames.length - 1) {
                    this._frameIndex = 0;
                    delay = FRAME_STEP_MS;
                } else {
                    this._frameIndex += 1;
                    if (this._frameIndex === this._rendered.frames.length - 1) delay = FRAME_STEP_MS + HOLD_NEWEST_MS;
                }
                this._syncControls();
                this._map.queue_repaint();
            }
            this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, step);
            return GLib.SOURCE_REMOVE;
        };
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_STEP_MS, step);
    }

    _stopTimer() {
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _currentFrame() {
        if (!this._rendered || this._rendered.frames.length === 0) return null;
        return this._rendered.frames[Math.min(this._frameIndex, this._rendered.frames.length - 1)];
    }

    _syncStatus() {
        if (this._phase === 'loaded' && this._rendered) {
            this._status.visible = false;
        } else if (this._phase === 'failed') {
            this._status.visible = true;
            this._statusIcon.icon_name = 'network-offline-symbolic';
            this._statusLabel.text = 'Radar unavailable';
        } else {
            this._status.visible = !this._rendered;
            this._statusIcon.icon_name = 'content-loading-symbolic';
            this._statusLabel.text = 'Loading radar…';
        }
    }

    _syncControls() {
        const n = this._rendered?.frames.length ?? 0;
        const enabled = n >= 2;
        this._playButton.reactive = enabled;
        this._playButton.opacity = enabled ? Opacity.primary : Opacity.tertiary;
        this._playButton.get_child().icon_name = this._isPlaying ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._slider.reactive = enabled;
        this._suppressSlider = true;
        this._slider.value = n > 1 ? this._frameIndex / (n - 1) : 1;
        this._suppressSlider = false;
        const frame = this._currentFrame();
        this._timeLabel.text = frame && this._snapshot
            ? Fmt.clock(frame.time, this._snapshot.utcOffsetSeconds, this.ctx.use24h)
            : '—';
    }

    _paint(cr, w, h, area) {
        roundedRect(cr, 0, 0, w, h, 10);
        cr.clip();
        if (!this._rendered) {
            setSource(cr, foreground(area, 0.08));
            cr.paint();
            return;
        }
        const scale = w / RadarTileMath.outputSize;
        cr.save();
        cr.scale(scale, scale);
        const paintSurface = (surface, alpha) => {
            const pattern = new Cairo.SurfacePattern(surface);
            pattern.setFilter(Cairo.Filter.GOOD);
            cr.setSource(pattern);
            if (alpha < 1) cr.paintWithAlpha(alpha);
            else cr.paint();
        };
        paintSurface(this._rendered.base, 1);
        const frame = this._currentFrame();
        if (frame) paintSurface(frame.overlay, 0.6);
        paintSurface(this._rendered.labels, 1);
        cr.restore();
    }
}
