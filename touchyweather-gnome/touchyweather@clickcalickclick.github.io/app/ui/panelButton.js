import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {conditionIconName} from '../../weathercore/models.js';
import {MenuBarStyle} from '../prefsStore.js';
import {Fmt} from '../formatting.js';

/**
 * The top-bar item (MenuBarLabel.swift / US-1): a condition glyph (day/night
 * variant) plus the current temperature, per the selected style. Falls back
 * to a neutral cloud glyph before the first snapshot arrives.
 */
export const TouchyWeatherButton = GObject.registerClass(
class TouchyWeatherButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'TouchyWeather', false);
        this._box = new St.BoxLayout({style_class: 'tw-panel-box', orientation: Clutter.Orientation.HORIZONTAL, y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: 'weather-overcast-symbolic', style_class: 'system-status-icon tw-panel-icon'});
        this._label = new St.Label({text: '--°', style_class: 'tw-panel-label', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);
        this.accessible_name = 'TouchyWeather';
    }

    update(snapshot, style) {
        this._icon.icon_name = snapshot ? conditionIconName(snapshot.condition, snapshot.isDay) : 'weather-overcast-symbolic';
        this._label.text = snapshot ? Fmt.temperature(snapshot.temperature) : '--°';
        this._icon.visible = style !== MenuBarStyle.TEMP_ONLY;
        this._label.visible = style !== MenuBarStyle.ICON_ONLY;
    }

    openMenu() {
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    }
});
