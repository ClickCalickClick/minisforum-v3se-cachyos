import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

/**
 * Development aid, inert unless TW_DEV_SCREENSHOT_DIR is set in the Shell's
 * environment (e.g. a nested `gnome-shell --nested --wayland` dev session):
 * opens the popover after the first refresh, then writes stage screenshots
 * of the card stack scrolled top → bottom into that directory. In-process
 * Shell.Screenshot sidesteps the D-Bus screenshot allow-list, so this works
 * in nested and headless sessions where no screenshot tool can reach the stage.
 */
export class DevScreenshots {
    static maybeStart(extension) {
        const dir = GLib.getenv('TW_DEV_SCREENSHOT_DIR');
        if (!dir) return null;
        const d = new DevScreenshots(extension, dir);
        d.start();
        return d;
    }

    constructor(extension, dir) {
        this.ext = extension;
        this.dir = dir;
        this._ids = [];
    }

    _later(seconds, fn) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._ids = this._ids.filter(x => x !== id);
            fn().catch(e => console.error(`TouchyWeather dev: ${e.message}\n${e.stack}`));
            return GLib.SOURCE_REMOVE;
        });
        this._ids.push(id);
    }

    start() {
        GLib.mkdir_with_parents(this.dir, 0o755);
        this._later(6, async () => {
            await this.shoot('01-panel');
            this.ext._button.openMenu();
        });
        this._later(9, () => this.shoot('02-popover-top'));
        // Wait for the radar to load, then walk the stack.
        this._later(16, async () => {
            const scroll = this._scrollView();
            if (!scroll) return;
            const adj = scroll.get_vadjustment();
            const pages = Math.max(1, Math.ceil((adj.upper - adj.page_size) / (adj.page_size * 0.9)));
            for (let i = 1; i <= pages; i++) {
                adj.value = Math.min(adj.upper - adj.page_size, i * adj.page_size * 0.9);
                await this._sleep(700);
                await this.shoot(`0${2 + i}-popover-page${i}`);
            }
            await this._sleep(300);
            await this.shoot('09-popover-bottom');
        });
        this._later(24, async () => {
            // Locations surface.
            this.ext._popover._showingLocations = true;
            this.ext._popover.render();
            await this._sleep(600);
            await this.shoot('10-locations');
            this.ext._popover._locationsView?._entry.set_text('Daven');
            await this._sleep(1500);
            await this.shoot('11-search');
            this.ext._popover._locationsView?._entry.set_text('');
            this.ext._popover._showingLocations = false;
            this.ext._popover.render();
        });
        this._later(28, async () => {
            this.ext._notifications.debugSendTestNotification();
            await this._sleep(1200);
            await this.shoot('12-notification');
            this.ext._button.menu.close();
            console.log('TouchyWeather dev: screenshots done');
        });
    }

    _scrollView() {
        const content = this.ext._popover._content;
        const find = actor => {
            if (actor.constructor?.name === 'St_ScrollView' || actor.get_vadjustment) return actor;
            for (const child of actor.get_children?.() ?? []) {
                const found = find(child);
                if (found) return found;
            }
            return null;
        };
        return find(content);
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._ids = this._ids.filter(x => x !== id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._ids.push(id);
        });
    }

    async shoot(name) {
        const path = GLib.build_filenamev([this.dir, `${name}.png`]);
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shooter = new Shell.Screenshot();
        await shooter.screenshot(false, stream);
        stream.close(null);
        console.log(`TouchyWeather dev: wrote ${path}`);
    }

    destroy() {
        for (const id of this._ids) GLib.source_remove(id);
        this._ids = [];
    }
}
