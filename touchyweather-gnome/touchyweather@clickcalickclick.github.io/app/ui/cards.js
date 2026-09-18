import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Cairo from 'cairo';

import {conditionDescription, conditionIconName, displayTitle, Severity, moonDisplayName} from '../../weathercore/models.js';
import {uvLabel, aqiLabel, pollenLabel} from '../../weathercore/labels.js';
import {Fmt} from '../formatting.js';
import {
    Palette, Opacity, label, icon, hbox, vbox, spacer, card, arcGauge,
    drawingArea, foreground, setSource, roundedRect, enableTouchScroll,
} from './widgets.js';

/**
 * The card stack (spec.md US-2, cards 0–8). Each builder takes the snapshot and
 * a render context `{prefs, use24h}` and returns an actor. Radar (card 9) lives
 * in radarCard.js because it keeps state across renders.
 */

// ---- 0 — Alert banner ------------------------------------------------------

function severityStyle(severity) {
    switch (severity) {
    case Severity.EXTREME: return {tint: 'red', text: 'Extreme'};
    case Severity.SEVERE: return {tint: 'red', text: 'Severe'};
    case Severity.MODERATE: return {tint: 'orange', text: 'Moderate'};
    case Severity.MINOR: return {tint: 'yellow', text: 'Minor'};
    default: return {tint: 'gray', text: 'Advisory'};
    }
}

export function alertBannerCard(alert, snapshot, ctx, initiallyExpanded = false) {
    const {tint, text} = severityStyle(alert.severity);
    const box = vbox({styleClass: `tw-alert tw-alert-${tint}`, xExpand: true});

    const header = hbox({xExpand: true, style: 'spacing: 8px;'});
    header.add_child(icon('dialog-warning-symbolic', `tw-small-icon tw-tint-${tint}`, {yAlign: Clutter.ActorAlign.START}));
    const titles = vbox({xExpand: true});
    titles.add_child(label(alert.event, 'tw-callout-medium', {wrap: true}));
    titles.add_child(label(text.toUpperCase(), `tw-caption2 tw-tint-${tint}`));
    header.add_child(titles);
    const chevron = icon('pan-down-symbolic', 'tw-small-icon', {opacity: Opacity.secondary});
    header.add_child(chevron);
    box.add_child(header);

    const details = vbox({xExpand: true, style: 'spacing: 6px;'});
    if (alert.headline) details.add_child(label(alert.headline, 'tw-caption', {wrap: true}));
    const stamp = effectiveExpiryLine(alert, snapshot, ctx);
    if (stamp) {
        const row = hbox({style: 'spacing: 4px;'});
        row.add_child(icon('alarm-symbolic', 'tw-tiny-icon', {opacity: Opacity.secondary}));
        row.add_child(label(stamp, 'tw-caption2', {opacity: Opacity.secondary}));
        details.add_child(row);
    }
    if (alert.details) details.add_child(label(alert.details.trim(), 'tw-caption', {opacity: Opacity.secondary, wrap: true}));
    if (alert.instruction) {
        const what = vbox({xExpand: true, style: 'spacing: 2px; padding-top: 2px;'});
        what.add_child(label('WHAT TO DO', 'tw-caption2', {opacity: Opacity.tertiary}));
        what.add_child(label(alert.instruction.trim(), 'tw-caption', {wrap: true}));
        details.add_child(what);
    }
    details.visible = initiallyExpanded;
    chevron.icon_name = initiallyExpanded ? 'pan-up-symbolic' : 'pan-down-symbolic';
    box.add_child(details);

    const wrapper = new St.Button({style_class: 'tw-alert-button', x_expand: true, can_focus: true, reactive: true, track_hover: false});
    wrapper.set_child(box);
    wrapper.accessible_name = `${text} alert: ${alert.event}`;
    wrapper.connect('clicked', () => {
        details.visible = !details.visible;
        chevron.icon_name = details.visible ? 'pan-up-symbolic' : 'pan-down-symbolic';
    });
    return wrapper;
}

function effectiveExpiryLine(alert, snapshot, ctx) {
    const fmt = s => Fmt.dateTime(s, snapshot.utcOffsetSeconds, ctx.use24h);
    if (alert.onset !== null && alert.ends !== null) return `${fmt(alert.onset)} → ${fmt(alert.ends)}`;
    if (alert.onset !== null) return `Effective ${fmt(alert.onset)}`;
    if (alert.ends !== null) return `Until ${fmt(alert.ends)}`;
    return null;
}

// ---- 1 — Current -----------------------------------------------------------

export function currentCard(snapshot, ctx) {
    const c = card();
    const titles = vbox({xExpand: true, style: 'spacing: 2px;'});
    titles.add_child(label(displayTitle(snapshot.location), 'tw-headline', {ellipsize: true}));
    titles.add_child(label(conditionDescription(snapshot.condition), 'tw-subheadline', {opacity: Opacity.secondary}));
    c.add_child(titles);

    const row = hbox({xExpand: true, style: 'spacing: 16px;'});
    row.add_child(icon(conditionIconName(snapshot.condition, snapshot.isDay), 'tw-current-icon'));
    const temps = vbox({style: 'spacing: 2px;', yAlign: Clutter.ActorAlign.CENTER});
    temps.add_child(label(Fmt.temperature(snapshot.temperature), 'tw-big-temp'));
    temps.add_child(label(`Feels like ${Fmt.temperature(snapshot.feelsLike)}`, 'tw-caption', {opacity: Opacity.secondary}));
    row.add_child(temps);
    row.add_child(spacer());
    c.add_child(row);

    const pill = Fmt.rainPill(snapshot.rainAlertMinutes);
    if (pill) {
        const p = hbox({styleClass: 'tw-pill tw-pill-rain'});
        p.add_child(icon('weather-showers-symbolic', 'tw-small-icon'));
        p.add_child(label(pill, ''));
        c.add_child(p);
    }

    const grid = hbox({xExpand: true, style: 'spacing: 20px;'});
    const hi = snapshot.high !== null ? Fmt.temperature(snapshot.high) : '—';
    const lo = snapshot.low !== null ? Fmt.temperature(snapshot.low) : '—';
    grid.add_child(metric('High / Low', `${hi} / ${lo}`));
    grid.add_child(metric('Wind', Fmt.wind(snapshot)));
    grid.add_child(ctx.prefs.showDewPoint
        ? metric('Dew Point', Fmt.temperature(snapshot.dewPoint))
        : metric('Humidity', `${snapshot.humidity}%`));
    c.add_child(grid);
    return c;
}

function metric(name, value) {
    const v = vbox({xExpand: true, style: 'spacing: 2px;'});
    v.add_child(label(name.toUpperCase(), 'tw-metric-label', {opacity: Opacity.tertiary}));
    v.add_child(label(value, 'tw-metric-value'));
    return v;
}

// ---- 2 — Hourly strip ------------------------------------------------------

export function hourlyCard(snapshot, ctx) {
    const c = card({title: 'Next Hours', iconName: 'alarm-symbolic'});
    const scroll = new St.ScrollView({
        hscrollbar_policy: St.PolicyType.EXTERNAL,
        vscrollbar_policy: St.PolicyType.NEVER,
        overlay_scrollbars: true,
        x_expand: true,
    });
    const strip = hbox({styleClass: 'tw-hour-strip'});
    for (const hour of snapshot.hourly.slice(0, 12)) strip.add_child(hourCell(hour, snapshot, ctx));
    scroll.set_child(strip);
    enableTouchScroll(scroll, Clutter.Orientation.HORIZONTAL);
    // Route the vertical wheel to horizontal scrolling so the strip is
    // reachable with a plain mouse wheel (the outer stack scrolls otherwise).
    scroll.connect('scroll-event', (_a, event) => {
        const adj = scroll.get_hadjustment();
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) delta = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) delta = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        }
        if (delta === 0) return Clutter.EVENT_PROPAGATE;
        adj.value = Math.max(adj.lower, Math.min(adj.upper - adj.page_size, adj.value + delta * 54));
        return Clutter.EVENT_STOP;
    });
    c.add_child(scroll);
    return c;
}

function hourCell(hour, snapshot, ctx) {
    const cell = vbox({styleClass: 'tw-hour-cell', xAlign: Clutter.ActorAlign.CENTER});
    const center = Clutter.ActorAlign.CENTER;
    cell.add_child(label(Fmt.hourLabel(hour.time, snapshot.utcOffsetSeconds, ctx.use24h), 'tw-caption2', {opacity: Opacity.secondary, align: center}));
    cell.add_child(icon(conditionIconName(hour.condition, isDayAt(hour.time, snapshot)), 'tw-hour-icon'));
    cell.add_child(label(Fmt.temperature(hour.temperature), 'tw-callout-medium', {align: center}));
    const pop = hbox({style: 'spacing: 2px;', xAlign: center});
    const drop = icon('weather-showers-symbolic', 'tw-tiny-icon tw-tint-precip', {opacity: hour.precipProbability > 0 ? Opacity.primary : 90});
    pop.add_child(drop);
    pop.add_child(label(`${hour.precipProbability}%`, 'tw-caption2', {opacity: Opacity.secondary}));
    cell.add_child(pop);
    cell.add_child(label(`${Math.round(hour.windSpeed)} ${hour.windDirection}`, 'tw-tiny', {opacity: Opacity.tertiary, align: center}));
    return cell;
}

/** Day/night for a glyph: within sunrise…sunset when known, else current isDay. */
function isDayAt(time, snapshot) {
    if (snapshot.sunrise === null || snapshot.sunset === null) return snapshot.isDay;
    return time >= snapshot.sunrise && time < snapshot.sunset;
}

// ---- 3 — Precipitation -----------------------------------------------------

export function precipitationCard(snapshot) {
    const c = card({title: 'Precipitation', iconName: 'weather-showers-scattered-symbolic'});
    const values = snapshot.precipProbNext5.slice(0, 5);
    if (values.every(v => v === 0)) {
        c.add_child(label('No rain expected', 'tw-callout', {opacity: Opacity.secondary}));
        return c;
    }
    const labels = ['Now', '+1h', '+2h', '+3h', '+4h'];
    const row = hbox({xExpand: true, style: 'spacing: 12px;'});
    values.forEach((pop, i) => {
        const col = vbox({xExpand: true, style: 'spacing: 4px;'});
        col.add_child(label(`${pop}%`, 'tw-caption2', {opacity: pop > 0 ? Opacity.primary : Opacity.secondary, align: Clutter.ActorAlign.CENTER}));
        col.add_child(drawingArea(0, 60, (cr, w, h) => {
            const bh = Math.max(2, h * pop / 100);
            setSource(cr, [...Palette.precip.slice(0, 3), pop > 0 ? 0.85 : 0.2]);
            roundedRect(cr, 0, h - bh, w, bh, 3);
            cr.fill();
        }, {xExpand: true}));
        col.add_child(label(labels[i], 'tw-caption2', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER}));
        row.add_child(col);
    });
    c.add_child(row);
    return c;
}

// ---- 4 — Week --------------------------------------------------------------

export function weekCard(snapshot) {
    const c = card({title: 'Week Ahead', iconName: 'x-office-calendar-symbolic'});
    const days = snapshot.daily.slice(0, 7);
    const min = Math.min(...days.map(d => d.low));
    const max = Math.max(...days.map(d => d.high));
    const total = Math.max(1, max - min);
    const list = vbox({xExpand: true, style: 'spacing: 8px;'});
    days.forEach((day, idx) => {
        const row = hbox({styleClass: 'tw-week-row', xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        row.add_child(label(idx === 0 ? 'Today' : Fmt.weekday(day.date, snapshot.utcOffsetSeconds), 'tw-caption tw-week-day'));
        row.add_child(icon(conditionIconName(day.condition, true), 'tw-week-icon'));
        const pop = hbox({styleClass: 'tw-week-pop', yAlign: Clutter.ActorAlign.CENTER});
        pop.add_child(icon('weather-showers-symbolic', 'tw-tiny-icon tw-tint-precip', {opacity: day.precipProbabilityMax > 0 ? Opacity.primary : 76}));
        pop.add_child(label(`${day.precipProbabilityMax}%`, 'tw-caption2', {opacity: Opacity.secondary}));
        row.add_child(pop);
        row.add_child(label(Fmt.temperature(day.low), 'tw-caption tw-week-low', {opacity: Opacity.secondary, align: Clutter.ActorAlign.END}));
        row.add_child(drawingArea(0, 14, (cr, w, h, a) => {
            const x0 = (day.low - min) / total * w;
            const x1 = (day.high - min) / total * w;
            const y = h / 2 - 2.5;
            setSource(cr, foreground(a, 0.15));
            roundedRect(cr, 0, y, w, 5, 2.5);
            cr.fill();
            const bw = Math.max(4, x1 - x0);
            const grad = new Cairo.LinearGradient(x0, 0, x0 + bw, 0);
            grad.addColorStopRGBA(0, ...Palette.cool);
            grad.addColorStopRGBA(1, ...Palette.warm);
            cr.setSource(grad);
            roundedRect(cr, x0, y, bw, 5, 2.5);
            cr.fill();
        }, {xExpand: true}));
        row.add_child(label(Fmt.temperature(day.high), 'tw-caption tw-week-high', {align: Clutter.ActorAlign.START}));
        list.add_child(row);
    });
    c.add_child(list);
    return c;
}

// ---- 5 — UV ----------------------------------------------------------------

export function uvCard(snapshot) {
    const c = card({title: 'UV Index', iconName: 'weather-clear-symbolic'});
    const uv = snapshot.uv ?? 0;
    const row = hbox({xExpand: true, style: 'spacing: 16px;', yAlign: Clutter.ActorAlign.CENTER});
    const center = vbox({xAlign: Clutter.ActorAlign.CENTER});
    center.add_child(label(`${uv}`, 'tw-big-number', {align: Clutter.ActorAlign.CENTER}));
    center.add_child(label(uvLabel(uv), 'tw-tiny', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER}));
    row.add_child(arcGauge(Math.min(uv, 11) / 11, Palette.uv(uv), center));

    const right = vbox({style: 'spacing: 10px;', yAlign: Clutter.ActorAlign.CENTER});
    if (snapshot.uvMax !== null) {
        const peak = vbox({style: 'spacing: 1px;'});
        peak.add_child(label('PEAK TODAY', 'tw-tiny', {opacity: Opacity.tertiary}));
        peak.add_child(label(`${snapshot.uvMax}`, 'tw-title3'));
        right.add_child(peak);
    }
    const next6 = snapshot.hourly.slice(0, 6).map(h => h.uv);
    if (next6.length) {
        const curve = vbox({style: 'spacing: 3px;'});
        curve.add_child(label('NEXT 6H', 'tw-tiny', {opacity: Opacity.tertiary}));
        curve.add_child(drawingArea(next6.length * 12 - 4, 28, (cr, w, h) => {
            next6.forEach((v, i) => {
                const bh = Math.max(3, Math.min(v, 11) / 11 * 28);
                setSource(cr, Palette.uv(v));
                roundedRect(cr, i * 12, h - bh, 8, bh, 2);
                cr.fill();
            });
        }));
        right.add_child(curve);
    }
    row.add_child(right);
    row.add_child(spacer());
    c.add_child(row);
    return c;
}

// ---- 6 — Air Quality -------------------------------------------------------

export function airQualityCard(snapshot) {
    const c = card({title: 'Air Quality', iconName: 'weather-windy-symbolic'});
    const aqi = snapshot.aqi ?? 0;
    const row = hbox({xExpand: true, style: 'spacing: 16px;', yAlign: Clutter.ActorAlign.CENTER});
    const center = vbox({xAlign: Clutter.ActorAlign.CENTER, style: 'width: 92px;'});
    const big = label(`${aqi}`, 'tw-big-number', {align: Clutter.ActorAlign.CENTER});
    big.style = `color: ${Palette.css(Palette.aqi(aqi))};`;
    center.add_child(big);
    center.add_child(label(aqiLabel(aqi), 'tw-tiny', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER, wrap: true}));
    row.add_child(arcGauge(Math.min(aqi, 300) / 300, Palette.aqi(aqi), center));

    const right = vbox({style: 'spacing: 6px;', yAlign: Clutter.ActorAlign.CENTER});
    const grid = vbox({style: 'spacing: 4px;'});
    const r1 = hbox({style: 'spacing: 12px;'});
    r1.add_child(pollutant('PM2.5', snapshot.pm25));
    r1.add_child(pollutant('PM10', snapshot.pm10));
    const r2 = hbox({style: 'spacing: 12px;'});
    r2.add_child(pollutant('O₃', snapshot.o3));
    r2.add_child(pollutant('NO₂', snapshot.no2));
    grid.add_child(r1);
    grid.add_child(r2);
    right.add_child(grid);
    if (snapshot.pollenLevel !== null && snapshot.pollenLevel !== undefined) {
        const level = snapshot.pollenLevel;
        const badge = hbox({styleClass: `tw-pill tw-pollen-${Math.min(level, 5)}`, style: 'padding: 3px 8px;'});
        badge.add_child(icon('emoji-nature-symbolic', 'tw-tiny-icon'));
        badge.add_child(label(`Pollen: ${pollenLabel(level)}`, 'tw-caption2'));
        right.add_child(badge);
    }
    row.add_child(right);
    row.add_child(spacer());
    c.add_child(row);
    return c;
}

function pollutant(name, value) {
    const h = hbox({style: 'spacing: 4px; min-width: 64px;', yAlign: Clutter.ActorAlign.CENTER});
    const n = label(name, 'tw-caption2', {opacity: Opacity.secondary});
    n.style = 'min-width: 34px;';
    h.add_child(n);
    h.add_child(label(value === null || value === undefined ? '—' : `${value}`, 'tw-caption2 tw-mono'));
    return h;
}

// ---- 7 — Sun & Moon --------------------------------------------------------

export function sunMoonCard(snapshot, ctx) {
    const c = card({title: 'Sun & Moon', iconName: 'daytime-sunrise-symbolic'});
    const row = hbox({xExpand: true, style: 'spacing: 12px;', yAlign: Clutter.ActorAlign.CENTER});
    const sun = vbox({xExpand: true, style: 'spacing: 10px;'});
    if (snapshot.sunrise !== null) sun.add_child(sunRow('daytime-sunrise-symbolic', 'tw-tint-warm', 'Sunrise', snapshot.sunrise, snapshot, ctx));
    if (snapshot.sunset !== null) sun.add_child(sunRow('daytime-sunset-symbolic', 'tw-tint-cool', 'Sunset', snapshot.sunset, snapshot, ctx));
    if (snapshot.sunrise === null && snapshot.sunset === null)
        sun.add_child(label('Sun does not rise/set today', 'tw-caption', {opacity: Opacity.secondary}));
    row.add_child(sun);
    const divider = new St.Widget({style: 'width: 1px; height: 56px; background-color: rgba(128,128,128,0.3);', y_align: Clutter.ActorAlign.CENTER});
    row.add_child(divider);

    const moon = vbox({style: 'spacing: 4px; width: 96px;', xAlign: Clutter.ActorAlign.CENTER});
    moon.add_child(moonGlyph(snapshot.moon, 34));
    moon.add_child(label(moonDisplayName(snapshot.moon), 'tw-tiny', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER, wrap: true}));
    moon.add_child(label(`${snapshot.moon.illumination}% lit`, 'tw-tiny', {opacity: Opacity.tertiary, align: Clutter.ActorAlign.CENTER}));
    row.add_child(moon);
    c.add_child(row);
    return c;
}

function sunRow(iconName, tintClass, name, time, snapshot, ctx) {
    const h = hbox({style: 'spacing: 8px;', yAlign: Clutter.ActorAlign.CENTER});
    h.add_child(icon(iconName, `tw-sun-icon ${tintClass}`));
    const v = vbox();
    v.add_child(label(name.toUpperCase(), 'tw-tiny', {opacity: Opacity.tertiary}));
    v.add_child(label(Fmt.clock(time, snapshot.utcOffsetSeconds, ctx.use24h), 'tw-callout-medium'));
    h.add_child(v);
    return h;
}

/**
 * A drawn moon: dark disc with the lit fraction in yellow, the terminator an
 * ellipse so crescents and gibbous phases read correctly (waxing lights the
 * right limb, waning the left — northern-hemisphere convention).
 */
export function moonGlyph(moon, size) {
    const k = Math.min(Math.max(moon.illumination / 100, 0), 1);
    const waxing = moon.phase >= 1 && moon.phase <= 3;
    const full = moon.phase === 4;
    const isNew = moon.phase === 0;
    const area = drawingArea(size, size, (cr, w, h, a) => {
        const r = Math.min(w, h) / 2 - 1;
        const cx = w / 2, cy = h / 2;
        setSource(cr, foreground(a, 0.18));
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.fill();
        if (isNew) return;
        setSource(cr, Palette.moon);
        if (full) {
            cr.arc(cx, cy, r, 0, 2 * Math.PI);
            cr.fill();
            return;
        }
        let e = r * (2 * k - 1);           // terminator x-radius, signed
        if (Math.abs(e) < 0.01) e = 0.01;
        cr.newPath();
        if (waxing) {
            cr.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);          // right limb, top→bottom
            cr.save(); cr.translate(cx, cy); cr.scale(e, r);
            cr.arc(0, 0, 1, Math.PI / 2, 3 * Math.PI / 2);           // back up along the terminator
            cr.restore();
        } else {
            cr.arc(cx, cy, r, Math.PI / 2, 3 * Math.PI / 2);        // left limb, bottom→top
            cr.save(); cr.translate(cx, cy); cr.scale(e, r);
            cr.arc(0, 0, 1, -Math.PI / 2, Math.PI / 2);              // back down along the terminator
            cr.restore();
        }
        cr.closePath();
        cr.fill();
    });
    area.x_align = Clutter.ActorAlign.CENTER;
    return area;
}

// ---- 8 — Golden Hour -------------------------------------------------------

export function goldenHourCard(snapshot, ctx) {
    const c = card({title: 'Golden Hour', iconName: 'camera-photo-symbolic'});
    const g = snapshot.goldenHours;
    const grid = vbox({xExpand: true, style: 'spacing: 10px;'});
    const r1 = hbox({xExpand: true, style: 'spacing: 10px;'});
    r1.add_child(milestone('Blue AM', g.blueAM, 'tw-tint-cool', 'night-light-symbolic', snapshot, ctx));
    r1.add_child(milestone('Golden AM', g.goldAM, 'tw-tint-warm', 'daytime-sunrise-symbolic', snapshot, ctx));
    const r2 = hbox({xExpand: true, style: 'spacing: 10px;'});
    r2.add_child(milestone('Golden PM', g.goldPM, 'tw-tint-warm', 'daytime-sunset-symbolic', snapshot, ctx));
    r2.add_child(milestone('Blue PM', g.bluePM, 'tw-tint-cool', 'night-light-symbolic', snapshot, ctx));
    grid.add_child(r1);
    grid.add_child(r2);
    c.add_child(grid);
    return c;
}

function milestone(name, time, tintClass, iconName, snapshot, ctx) {
    const h = hbox({xExpand: true, style: 'spacing: 8px;', yAlign: Clutter.ActorAlign.CENTER});
    h.add_child(icon(iconName, `tw-milestone-icon ${tintClass}`));
    const v = vbox();
    v.add_child(label(name.toUpperCase(), 'tw-tiny', {opacity: Opacity.tertiary}));
    v.add_child(label(time === null || time === undefined ? '—' : Fmt.clock(time, snapshot.utcOffsetSeconds, ctx.use24h), 'tw-callout-medium'));
    h.add_child(v);
    return h;
}
