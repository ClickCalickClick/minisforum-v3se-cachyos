import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Faults} from '../../weathercore/weatherService.js';
import {Fmt} from '../formatting.js';
import {Opacity, label, icon, hbox, vbox, spacer, button, enableTouchScroll} from './widgets.js';
import {
    alertBannerCard, currentCard, hourlyCard, precipitationCard, weekCard,
    uvCard, airQualityCard, sunMoonCard, goldenHourCard,
} from './cards.js';
import {LocationsView} from './locationsView.js';

/**
 * The popover (PopoverRootView.swift): a vertical stack of cards (US-2 order)
 * plus the footer, or the onboarding / locations surfaces. Cards hide
 * themselves when their data is missing. Opening triggers a gated refresh.
 */
export class Popover {
    constructor({weatherStore, locationStore, prefs, radarCard, geocodingClient, notifications, onOpenPrefs, onQuit, onRefresh}) {
        this.weather = weatherStore;
        this.locations = locationStore;
        this.prefs = prefs;
        this.radarCard = radarCard;
        this.geocodingClient = geocodingClient;
        this.notifications = notifications;
        this.onOpenPrefs = onOpenPrefs;
        this.onQuit = onQuit;
        this.onRefresh = onRefresh;
        this._showingLocations = false;
        this._locationsView = null;
        this._renderId = 0;
        this._isOpen = false;
        this._lastMode = null;

        this._root = vbox({styleClass: 'tw-root', xExpand: true});
        this._content = vbox({xExpand: true});
        this._root.add_child(this._content);

        this._section = new PopupMenu.PopupMenuSection();
        this._section.actor.add_child(this._root);
    }

    /** The PopupMenuSection to add to the panel button's menu. */
    get menuSection() {
        return this._section;
    }

    get ctx() {
        return {prefs: this.prefs, use24h: this.prefs.uses24HourClock};
    }

    destroy() {
        if (this._renderId) GLib.source_remove(this._renderId);
        this._renderId = 0;
        this._locationsView?.destroy();
        this._locationsView = null;
        this._section.destroy();
    }

    /** Called by the panel button on open/close. */
    setOpen(open) {
        this._isOpen = open;
        this.radarCard.setVisible(open && !this._showingLocations && this.locations.mode === 'ready');
        if (open) {
            this._root.remove_style_class_name('tw-dark');
            this._root.remove_style_class_name('tw-light');
            this._root.add_style_class_name(Main.getStyleVariant?.() === 'light' ? 'tw-light' : 'tw-dark');
            this.render();
            if (this._locationsView) this._locationsView.focusSearch();
        } else {
            // Leaving the locations surface on close mirrors the Mac popover:
            // it reopens on the cards (a preview stays previewing).
            this._showingLocations = false;
        }
    }

    /** Coalesce bursts of store changes into one rebuild per main-loop pass. */
    queueRender() {
        if (this._renderId) return;
        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderId = 0;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    render() {
        const mode = this.locations.mode;
        if (this.locations.isLocatingFirstFix && !this.weather.activeSnapshot) {
            this._swap('locating', () => this._locatingView());
        } else if (mode === 'onboarding') {
            this._swap('onboarding', () => this._locationsSurface(true));
        } else if (this._showingLocations) {
            this._swap('locations', () => this._locationsSurface(false));
            this._locationsView?.refreshList();
        } else {
            this._swap('weather', () => this._weatherView(), /* always rebuild */ true);
        }
        this.radarCard.setVisible(this._isOpen && this._lastMode === 'weather');
    }

    _swap(mode, build, alwaysRebuild = false) {
        if (mode === this._lastMode && !alwaysRebuild) return;
        // Detach the persistent radar card before its old parent is destroyed.
        const radar = this.radarCard.actor;
        radar.get_parent()?.remove_child(radar);
        if (this._lastMode === 'locations' || this._lastMode === 'onboarding') {
            if (mode !== 'locations' && mode !== 'onboarding') {
                this._locationsView?.destroy();
                this._locationsView = null;
            }
        }
        this._content.destroy_all_children();
        this._content.add_child(build());
        this._lastMode = mode;
    }

    // ---- surfaces ----

    _locationsSurface(isOnboarding) {
        this._locationsView?.destroy();
        this._locationsView = new LocationsView({
            locationStore: this.locations,
            weatherStore: this.weather,
            geocodingClient: this.geocodingClient,
            isOnboarding,
            onClose: () => {
                this._showingLocations = false;
                this.render();
            },
        });
        const box = vbox({xExpand: true});
        box.add_child(this._locationsView.actor);
        if (this._isOpen) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._locationsView?.focusSearch(); return GLib.SOURCE_REMOVE; });
        return box;
    }

    _locatingView() {
        const box = vbox({styleClass: 'tw-placeholder', xExpand: true, xAlign: Clutter.ActorAlign.CENTER});
        box.add_child(icon('find-location-symbolic', 'tw-placeholder-icon', {opacity: Opacity.secondary}));
        box.add_child(label('Finding your location…', 'tw-headline', {align: Clutter.ActorAlign.CENTER}));
        box.add_child(label('This can take a moment the first time.', 'tw-caption', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER}));
        return box;
    }

    _weatherView() {
        const box = vbox({xExpand: true});
        if (this.locations.showDeniedHint) box.add_child(this._deniedHint());
        if (this.locations.isPreviewingUnsaved) box.add_child(this._previewBar());

        const scroll = new St.ScrollView({
            style_class: 'tw-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        scroll.style = `height: ${Popover.popoverHeight()}px;`;
        enableTouchScroll(scroll, Clutter.Orientation.VERTICAL);
        const stack = vbox({styleClass: 'tw-cards', xExpand: true});
        const snapshot = this.weather.activeSnapshot;
        if (snapshot) {
            for (const child of this._cards(snapshot)) stack.add_child(child);
        } else {
            stack.add_child(this._placeholder());
        }
        scroll.set_child(stack);
        box.add_child(scroll);
        box.add_child(new St.Widget({style: 'height: 1px; background-color: rgba(128,128,128,0.3);', x_expand: true}));
        box.add_child(this._footer(snapshot));
        return box;
    }

    /** US-2 card order; each card included only when it has data to show. */
    _cards(snapshot) {
        const ctx = this.ctx;
        const out = [];
        const alerts = [...(snapshot.alerts ?? [])].sort((a, b) => b.severity - a.severity);
        for (const alert of alerts) out.push(alertBannerCard(alert, snapshot, ctx));        // 0
        out.push(currentCard(snapshot, ctx));                                              // 1 — always
        if (snapshot.hourly.length) out.push(hourlyCard(snapshot, ctx));                    // 2
        out.push(precipitationCard(snapshot));                                              // 3
        if (snapshot.daily.length) out.push(weekCard(snapshot));                            // 4
        if (snapshot.uv !== null && snapshot.uv !== undefined) out.push(uvCard(snapshot));  // 5
        if (snapshot.aqi !== null && snapshot.aqi !== undefined) out.push(airQualityCard(snapshot)); // 6
        out.push(sunMoonCard(snapshot, ctx));                                              // 7
        out.push(goldenHourCard(snapshot, ctx));                                           // 8
        this.radarCard.setSnapshot(snapshot);                                              // 9
        out.push(this.radarCard.actor);
        return out;
    }

    _placeholder() {
        const box = vbox({styleClass: 'tw-placeholder', xExpand: true, xAlign: Clutter.ActorAlign.CENTER});
        const phase = this.weather.phase;
        if (phase.kind === 'failed') {
            box.add_child(icon('network-offline-symbolic', 'tw-placeholder-icon', {opacity: Opacity.secondary}));
            box.add_child(label(phase.message, 'tw-headline', {align: Clutter.ActorAlign.CENTER}));
            box.add_child(label('No data yet — check your connection.', 'tw-caption', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER}));
        } else {
            box.add_child(icon('content-loading-symbolic', 'tw-placeholder-icon', {opacity: Opacity.secondary}));
            box.add_child(label('Loading weather…', 'tw-caption', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER}));
        }
        return box;
    }

    // ---- banners ----

    _deniedHint() {
        const bar = hbox({styleClass: 'tw-banner tw-banner-yellow', xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        bar.add_child(icon('location-services-disabled-symbolic', 'tw-small-icon', {opacity: Opacity.secondary, yAlign: Clutter.ActorAlign.START}));
        bar.add_child(label(`Location access is off. Showing ${this.weather.activeLocation?.name ?? 'a saved location'}. Turn on Location Services in Settings → Privacy to use your current location.`,
            'tw-caption', {wrap: true, xExpand: true}));
        bar.add_child(button({iconName: 'window-close-symbolic', iconClass: 'tw-small-icon', styleClass: 'tw-row-button', tooltip: 'Dismiss', onClick: () => this.locations.dismissDeniedHint()}));
        return bar;
    }

    _previewBar() {
        const bar = hbox({styleClass: 'tw-banner tw-banner-blue', xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        bar.add_child(icon('mark-location-symbolic', 'tw-small-icon', {opacity: Opacity.secondary}));
        bar.add_child(label(`Previewing ${this.weather.activeLocation?.name ?? 'location'}`, 'tw-caption', {xExpand: true, ellipsize: true}));
        bar.add_child(button({child: label('Discard', 'tw-caption'), styleClass: 'tw-small-button', onClick: () => this.locations.clearPreview()}));
        bar.add_child(button({child: label('Save', 'tw-caption'), styleClass: 'tw-small-button tw-small-button-prominent', onClick: () => this.locations.savePreview()}));
        return bar;
    }

    // ---- footer ----

    _footer(snapshot) {
        const bar = hbox({styleClass: 'tw-footer', xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        const updated = label(snapshot ? Fmt.updatedAgo(snapshot.fetchedAt) : '—', 'tw-caption', {opacity: Opacity.secondary, xExpand: true});
        bar.add_child(updated);
        bar.add_child(this._debugMenu());
        bar.add_child(button({iconName: 'mark-location-symbolic', tooltip: 'Locations', onClick: () => {
            this._showingLocations = true;
            this.render();
        }}));
        const refreshing = this.weather.phase.kind === 'refreshing';
        const refresh = button({iconName: 'view-refresh-symbolic', tooltip: 'Refresh now', onClick: () => this.onRefresh()});
        if (refreshing) Popover._spin(refresh.get_child());
        bar.add_child(refresh);
        bar.add_child(button({iconName: 'preferences-system-symbolic', tooltip: 'Preferences', onClick: () => this.onOpenPrefs()}));
        bar.add_child(button({iconName: 'system-shutdown-symbolic', tooltip: 'Quit TouchyWeather (disables the extension)', onClick: () => this.onQuit()}));
        return bar;
    }

    /** The refresh glyph spins only while a refresh is in flight — the render
     *  that follows completion simply builds a non-spinning glyph. */
    static _spin(actor) {
        actor.set_pivot_point(0.5, 0.5);
        actor.rotation_angle_z = 0;
        actor.ease({
            rotation_angle_z: 360,
            duration: 900,
            mode: Clutter.AnimationMode.LINEAR,
            repeatCount: -1,
        });
    }

    /** Debug: fault injection so every card's empty/error state is reachable. */
    _debugMenu() {
        const b = button({iconName: 'emoji-nature-symbolic', tooltip: 'Debug: fault injection'});
        b.opacity = Opacity.tertiary;
        const menu = new PopupMenu.PopupMenu(b, 0.5, St.Side.BOTTOM);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        const toggle = (title, fault) => {
            const item = new PopupMenu.PopupSwitchMenuItem(title, (this.weather.debugFaults & fault) !== 0);
            item.connect('toggled', () => this.weather.toggleDebugFault(fault));
            menu.addMenuItem(item);
        };
        menu.addMenuItem(new PopupMenu.PopupMenuItem('Fault injection', {reactive: false}));
        toggle('Fail forecast (whole refresh)', Faults.FORECAST);
        toggle('Fail air quality', Faults.AIR_QUALITY);
        toggle('Fail pollen', Faults.POLLEN);
        toggle('Fail radar', Faults.RADAR);
        toggle('Fail alerts (empty banner)', Faults.ALERTS);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Send test notification', () => this.notifications.debugSendTestNotification());
        menu.addAction('Clear cache & reload', () => this.weather.debugClearCacheAndReload());
        menu.addAction('Reset all faults', () => this.weather.setDebugFaults(0));
        b.connect('clicked', () => menu.toggle());
        b.connect('destroy', () => menu.destroy());
        return b;
    }

    /** ~half the usable display, clamped so it stays comfortable on a small laptop. */
    static popoverHeight() {
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const usable = (monitor?.height ?? 900) / scale - (Main.panel?.height ?? 32) / scale;
        return Math.floor(Math.min(Math.max(usable * 0.5, 460), usable - 60));
    }
}
