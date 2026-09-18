import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {LocationKind, displayTitle} from '../../weathercore/models.js';
import {OpenMeteoGeocodingClient, geocodingDisplayLabel} from '../../weathercore/providers/geocoding.js';
import {Opacity, label, icon, hbox, vbox, spacer, button} from './widgets.js';

const DEBOUNCE_MS = 300;

/**
 * Location management (LocationsView.swift, spec.md US-3): a debounced city
 * search over Open-Meteo geocoding plus the saved-locations list (reorder,
 * delete, switch) with the pinned Current Location entry. Rendered inline in
 * the popover. In onboarding mode there's nothing to go back to, so the Done
 * button is hidden and the copy points at search.
 */
export class LocationsView {
    constructor({locationStore, weatherStore, geocodingClient, isOnboarding, onClose}) {
        this.locations = locationStore;
        this.weather = weatherStore;
        this.client = geocodingClient;
        this.isOnboarding = isOnboarding;
        this.onClose = onClose;
        this._debounceId = 0;
        this._cancellable = null;
        this._results = [];
        this._searchFailed = false;
        this._isSearching = false;
        this._build();
    }

    get actor() {
        return this._root;
    }

    destroy() {
        if (this._debounceId) GLib.source_remove(this._debounceId);
        this._debounceId = 0;
        this._cancellable?.cancel();
        this._root.destroy();
    }

    focusSearch() {
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    _build() {
        this._root = vbox({xExpand: true});

        const header = hbox({styleClass: 'tw-locations-header', xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        header.add_child(label(this.isOnboarding ? 'Add a Location' : 'Locations', 'tw-headline', {xExpand: true}));
        if (!this.isOnboarding) {
            header.add_child(button({child: label('Done', 'tw-caption'), styleClass: 'tw-small-button', onClick: () => this.onClose()}));
        }
        this._root.add_child(header);
        this._root.add_child(new St.Widget({style: 'height: 1px; background-color: rgba(128,128,128,0.3);', x_expand: true}));

        const body = vbox({styleClass: 'tw-locations-body', xExpand: true});
        body.add_child(this._buildSearch());
        this._list = vbox({xExpand: true, style: 'spacing: 12px;'});
        body.add_child(this._list);
        this._root.add_child(body);
        this.refreshList();
    }

    _buildSearch() {
        const box = vbox({xExpand: true, style: 'spacing: 6px;'});
        this._entry = new St.Entry({
            style_class: 'tw-search',
            hint_text: 'Search city…',
            can_focus: true,
            x_expand: true,
            primary_icon: icon('edit-find-symbolic', 'tw-small-icon', {opacity: Opacity.secondary}),
        });
        this._entry.clutter_text.connect('text-changed', () => this._onQueryChanged());
        this._entry.clutter_text.connect('activate', () => {
            if (this._results.length) this._select(this._results[0]);
        });
        this._entry.connect('secondary-icon-clicked', () => {
            this._entry.set_text('');
        });
        box.add_child(this._entry);
        if (this.isOnboarding) {
            box.add_child(label('Search for a city, or turn on Location Services in Settings → Privacy to use your current location.',
                'tw-caption', {opacity: Opacity.secondary, wrap: true}));
        }
        return box;
    }

    get _query() {
        return this._entry.get_text().trim();
    }

    _onQueryChanged() {
        this._entry.set_secondary_icon(this._entry.get_text() ? icon('edit-clear-symbolic', 'tw-small-icon', {opacity: Opacity.secondary}) : null);
        if (this._debounceId) GLib.source_remove(this._debounceId);
        this._cancellable?.cancel();
        const q = this._query;
        if (q.length < OpenMeteoGeocodingClient.minimumQueryLength) {
            this._results = [];
            this._searchFailed = false;
            this._isSearching = false;
            this.refreshList();
            return;
        }
        this._isSearching = true;
        this.refreshList();
        // Debounce (api-contract.md §3): the request only fires once typing pauses.
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._runSearch(q);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _runSearch(q) {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        try {
            const hits = await this.client.search(q, cancellable);
            if (cancellable.is_cancelled()) return;
            this._results = hits;
            this._searchFailed = false;
        } catch (_e) {
            if (cancellable.is_cancelled()) return;
            this._results = [];
            this._searchFailed = true;
        } finally {
            if (this._cancellable === cancellable) {
                this._cancellable = null;
                this._isSearching = false;
                this.refreshList();
            }
        }
    }

    /** Rebuild the list area (search results or the saved list). */
    refreshList() {
        this._list.destroy_all_children();
        if (this._query.length > 0) this._renderResults();
        else this._renderSaved();
    }

    _renderResults() {
        if (this._searchFailed) {
            const row = hbox({style: 'spacing: 6px;'});
            row.add_child(icon('dialog-warning-symbolic', 'tw-small-icon', {opacity: Opacity.secondary}));
            row.add_child(label('Search unavailable — check your connection.', 'tw-caption', {opacity: Opacity.secondary, wrap: true}));
            this._list.add_child(row);
        } else if (this._isSearching && this._results.length === 0) {
            this._list.add_child(label('Searching…', 'tw-caption', {opacity: Opacity.secondary}));
        } else if (this._results.length === 0) {
            this._list.add_child(label(`No matches for “${this._query}”.`, 'tw-caption', {opacity: Opacity.secondary, wrap: true}));
        } else {
            const list = vbox({xExpand: true});
            for (const result of this._results) {
                const row = hbox({xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
                row.add_child(label(geocodingDisplayLabel(result), 'tw-callout', {xExpand: true, ellipsize: true}));
                row.add_child(icon('list-add-symbolic', 'tw-small-icon', {opacity: Opacity.secondary}));
                const b = new St.Button({style_class: 'tw-result-row', x_expand: true, can_focus: true});
                b.set_child(row);
                b.connect('clicked', () => this._select(result));
                list.add_child(b);
            }
            this._list.add_child(list);
        }
    }

    _renderSaved() {
        const current = this.locations.currentLocation;
        if (current) {
            this._list.add_child(label('CURRENT LOCATION', 'tw-section-caption', {opacity: Opacity.secondary}));
            this._list.add_child(this._locationRow(current, {deletable: false}));
        }
        const saved = this.locations.saved;
        if (saved.length > 0) {
            this._list.add_child(label('SAVED', 'tw-section-caption', {opacity: Opacity.secondary}));
            const list = vbox({xExpand: true, style: 'spacing: 2px;'});
            saved.forEach((loc, i) => list.add_child(this._locationRow(loc, {deletable: true, index: i, count: saved.length})));
            this._list.add_child(list);
        } else if (!current) {
            this._list.add_child(label('No saved locations yet — search above to add one.', 'tw-caption', {opacity: Opacity.secondary, wrap: true}));
        }
    }

    _locationRow(location, {deletable, index = 0, count = 1}) {
        const isActive = location.id === this.locations.activeLocationID;
        const isCurrent = location.kind === LocationKind.CURRENT;
        const row = hbox({xExpand: true, yAlign: Clutter.ActorAlign.CENTER, style: 'spacing: 8px;'});
        row.add_child(icon(isCurrent ? 'find-location-symbolic' : 'mark-location-symbolic', `tw-small-icon${isCurrent ? ' tw-accent' : ''}`, {opacity: isCurrent ? Opacity.primary : Opacity.secondary}));
        row.add_child(label(displayTitle(location), 'tw-callout', {xExpand: true, ellipsize: true}));
        if (isActive) row.add_child(icon('object-select-symbolic', 'tw-small-icon tw-accent'));
        if (deletable) {
            if (count > 1) {
                const up = button({iconName: 'go-up-symbolic', iconClass: 'tw-small-icon', styleClass: 'tw-row-button', tooltip: 'Move up', onClick: () => this.locations.moveSaved(index, index - 1)});
                up.reactive = index > 0; up.opacity = index > 0 ? Opacity.primary : Opacity.tertiary;
                const down = button({iconName: 'go-down-symbolic', iconClass: 'tw-small-icon', styleClass: 'tw-row-button', tooltip: 'Move down', onClick: () => this.locations.moveSaved(index, index + 1)});
                down.reactive = index < count - 1; down.opacity = index < count - 1 ? Opacity.primary : Opacity.tertiary;
                row.add_child(up);
                row.add_child(down);
            }
            row.add_child(button({iconName: 'edit-delete-symbolic', iconClass: 'tw-small-icon', styleClass: 'tw-row-button', tooltip: 'Delete', onClick: () => this.locations.remove(location.id)}));
        }
        const b = new St.Button({style_class: 'tw-location-row', x_expand: true, can_focus: true});
        b.set_child(row);
        b.connect('clicked', () => this._switchTo(location));
        return b;
    }

    // ---- actions ----

    /** A search pick switches to that place (unsaved preview) and offers Save. */
    _select(result) {
        this.locations.preview(result);
        this._entry.set_text('');
        this._results = [];
        this.onClose();
        this.weather.refresh(true);
    }

    _switchTo(location) {
        this.locations.setActive(location.id);
        this.onClose();
        this.weather.refresh(false);
    }
}
