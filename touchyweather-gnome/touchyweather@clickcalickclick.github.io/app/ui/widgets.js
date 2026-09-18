import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Cairo from 'cairo';

/**
 * Shared card visual vocabulary (CardChrome.swift / CardStyle.swift) built from
 * St widgets, plus Cairo helpers for the drawn bits (gauges, bars, moon).
 */

// ---- palette (Cairo RGBA; CSS classes carry the same values) ---------------
export const Palette = {
    warm: [1.0, 0.47, 0.0, 1],        // #ff7800 — highs, sunrise, warm accents
    cool: [0.384, 0.627, 0.918, 1],   // #62a0ea — lows, precip, sunset
    precip: [0.384, 0.627, 0.918, 1],
    green: [0.2, 0.82, 0.478, 1],     // #33d17a
    yellow: [0.961, 0.761, 0.067, 1], // #f5c211
    orange: [1.0, 0.47, 0.0, 1],
    red: [0.929, 0.2, 0.231, 1],      // #ed333b
    purple: [0.753, 0.38, 0.796, 1],  // #c061cb
    maroon: [0.5, 0.0, 0.13, 1],
    moon: [0.973, 0.894, 0.361, 1],   // #f8e45c

    /** UV band color (data-model.md §8). */
    uv(uv) {
        if (uv <= 2) return this.green;
        if (uv <= 5) return this.yellow;
        if (uv <= 7) return this.orange;
        if (uv <= 10) return this.red;
        return this.purple;
    },

    /** US-AQI band color. */
    aqi(aqi) {
        if (aqi <= 50) return this.green;
        if (aqi <= 100) return this.yellow;
        if (aqi <= 150) return this.orange;
        if (aqi <= 200) return this.red;
        if (aqi <= 300) return this.purple;
        return this.maroon;
    },

    css(rgba) {
        const [r, g, b, a] = rgba;
        return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
    },
};

export const Opacity = {primary: 255, secondary: 168, tertiary: 118};

// ---- basic builders --------------------------------------------------------

export function label(text, styleClass = '', {opacity = Opacity.primary, wrap = false, align = null, xExpand = false, yAlign = null, ellipsize = false} = {}) {
    const l = new St.Label({text: text ?? '', style_class: styleClass, x_expand: xExpand});
    l.opacity = opacity;
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    } else if (ellipsize) {
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }
    if (align !== null) l.x_align = align;
    if (yAlign !== null) l.y_align = yAlign;
    return l;
}

export function icon(iconName, styleClass = '', {opacity = Opacity.primary, yAlign = Clutter.ActorAlign.CENTER} = {}) {
    const i = new St.Icon({icon_name: iconName, style_class: styleClass, y_align: yAlign});
    i.opacity = opacity;
    return i;
}

export function hbox({styleClass = '', xExpand = false, yExpand = false, xAlign = null, yAlign = null, style = null} = {}) {
    const b = new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, style_class: styleClass, x_expand: xExpand, y_expand: yExpand});
    if (xAlign !== null) b.x_align = xAlign;
    if (yAlign !== null) b.y_align = yAlign;
    if (style) b.style = style;
    return b;
}

export function vbox({styleClass = '', xExpand = false, yExpand = false, xAlign = null, yAlign = null, style = null} = {}) {
    const b = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: styleClass, x_expand: xExpand, y_expand: yExpand});
    if (xAlign !== null) b.x_align = xAlign;
    if (yAlign !== null) b.y_align = yAlign;
    if (style) b.style = style;
    return b;
}

export function spacer() {
    return new St.Widget({x_expand: true});
}

export function button({child = null, styleClass = 'tw-footer-button', tooltip = null, onClick = null, iconName = null, iconClass = 'tw-footer-icon'} = {}) {
    const b = new St.Button({style_class: styleClass, can_focus: true, reactive: true, track_hover: true});
    if (iconName) b.set_child(icon(iconName, iconClass));
    else if (child) b.set_child(child);
    if (tooltip) b.accessible_name = tooltip;
    if (onClick) b.connect('clicked', () => onClick());
    return b;
}

/** A St.DrawingArea of a fixed logical size with a paint callback (cr, w, h, area). */
export function drawingArea(width, height, paint, {xExpand = false} = {}) {
    const area = new St.DrawingArea({x_expand: xExpand});
    if (width) area.set_width(width);
    if (height) area.set_height(height);
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        try {
            paint(cr, w, h, a);
        } finally {
            cr.$dispose();
        }
    });
    return area;
}

/** The theme's foreground color as Cairo RGBA — adapts to light/dark shells. */
export function foreground(actor, alpha = 1) {
    try {
        const c = actor.get_theme_node().get_foreground_color();
        return [c.red / 255, c.green / 255, c.blue / 255, alpha];
    } catch (_e) {
        return [1, 1, 1, alpha];
    }
}

export function setSource(cr, rgba) {
    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
}

/** A rounded rectangle path. */
export function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// ---- Card chrome -----------------------------------------------------------

/**
 * Shared card container: a titled section on a rounded background. The header
 * echoes the Pebble identity — a small glyph beside a tracked small-caps title.
 */
export function card({title = null, iconName = null} = {}) {
    const box = vbox({styleClass: 'tw-card', xExpand: true});
    if (title) {
        const header = hbox({styleClass: 'tw-card-header'});
        if (iconName) header.add_child(icon(iconName, 'tw-card-title-icon', {opacity: Opacity.secondary}));
        header.add_child(label(title.toUpperCase(), 'tw-card-title', {opacity: Opacity.secondary}));
        box.add_child(header);
    }
    return box;
}

/**
 * A half-donut gauge (open at the bottom), matching the Pebble UV/AQI dials:
 * a grey track with a colored fill sweeping left→right by `fraction`, and
 * centered content (the big number + label) nudged into the open dial.
 */
export function arcGauge(fraction, tint, centerActor) {
    const W = 132, H = 78;
    const container = new St.Widget({layout_manager: new Clutter.BinLayout(), width: W, height: H + 4});
    const f = Math.min(Math.max(fraction, 0), 1);
    const area = drawingArea(W, H + 4, (cr, w, h, a) => {
        const radius = Math.min(w / 2, h - 6) - 5;
        const cx = w / 2, cy = h - 4;
        cr.setLineWidth(10);
        cr.setLineCap(Cairo.LineCap.ROUND);
        setSource(cr, foreground(a, 0.25));
        cr.arc(cx, cy, radius, Math.PI, 2 * Math.PI);
        cr.stroke();
        if (f > 0) {
            setSource(cr, tint);
            cr.arc(cx, cy, radius, Math.PI, Math.PI + Math.PI * f);
            cr.stroke();
        }
    });
    container.add_child(area);
    centerActor.x_align = Clutter.ActorAlign.CENTER;
    centerActor.y_align = Clutter.ActorAlign.END;
    centerActor.x_expand = true;
    centerActor.y_expand = true;
    container.add_child(centerActor);
    return container;
}

// ---- Touch scrolling -------------------------------------------------------

/**
 * Make an St.ScrollView scroll with a finger drag. St only handles wheel and
 * touchpad scroll events; a touchscreen pan is a gesture, so (like the Shell's
 * own search view) a Clutter.PanGesture drives the adjustment 1:1 with the
 * finger, and a short ease-out fling continues it at the measured velocity.
 * The gesture's begin threshold keeps taps on buttons inside the view working.
 */
export function enableTouchScroll(scrollView, orientation = Clutter.Orientation.VERTICAL) {
    const vertical = orientation === Clutter.Orientation.VERTICAL;
    const gesture = new Clutter.PanGesture({
        pan_axis: vertical ? Clutter.PanAxis.Y : Clutter.PanAxis.X,
        begin_threshold: 8,
    });
    const adj = () => (vertical ? scrollView.get_vadjustment() : scrollView.get_hadjustment());
    let lastTime = 0;
    let velocity = 0;      // px per ms, sign = scroll direction

    gesture.connect('recognize', () => {
        adj().remove_transition('value');
        lastTime = GLib.get_monotonic_time();
        velocity = 0;
    });
    gesture.connect('pan-update', g => {
        const delta = g.get_delta();
        const d = vertical ? delta.get_y() : delta.get_x();
        const a = adj();
        a.value = Math.max(a.lower, Math.min(a.upper - a.page_size, a.value - d));
        const now = GLib.get_monotonic_time();
        const dt = Math.max(1, (now - lastTime) / 1000);
        // Exponential smoothing so a jittery last sample doesn't decide the fling.
        velocity = 0.6 * (-d / dt) + 0.4 * velocity;
        lastTime = now;
    });
    gesture.connect('end', () => {
        const a = adj();
        if (Math.abs(velocity) < 0.05) return;
        const distance = velocity * 320;    // ~ integral of an ease-out over ~640 ms
        const target = Math.max(a.lower, Math.min(a.upper - a.page_size, a.value + distance));
        a.ease(target, {duration: 640, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    });
    gesture.connect('cancel', () => {
        velocity = 0;
    });
    scrollView.add_action(gesture);
    return gesture;
}
