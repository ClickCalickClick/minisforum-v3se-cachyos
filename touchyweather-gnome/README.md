# TouchyWeather for GNOME

The Linux port of TouchyWeather for Mac: a **GNOME Shell extension** that puts
the condition glyph + temperature in the top bar and shows the same card stack
on click — severe-weather alerts, current conditions, next hours, precipitation,
7-day, UV, air quality (+ pollen), sun & moon, golden hour, and the animated
radar — plus the three notification triggers, saved locations with city search,
and a Preferences window. Built and tested on **GNOME Shell 50** (CachyOS,
Wayland); `metadata.json` also lists 48/49.

```
gnome/
├── install.sh                       install / --link (dev symlink) / --uninstall
├── touchyweather.desktop            desktop id the GeoClue agent authorizes
├── tests/run.js                     gjs -m tests/run.js  → parity + policy tests (369 expectations)
├── tests/live.js                    gjs -m tests/live.js → real-network pipeline smoke test
└── touchyweather@clickcalickclick.github.io/
    ├── extension.js  prefs.js  metadata.json  stylesheet.css  schemas/
    ├── weathercore/   pure port of Sources/WeatherCore (GLib/Gio/Soup only — no Shell)
    └── app/           Shell-side: stores, GeoClue, notifications, radar compositing, ui/
```

## Install

```bash
./gnome/install.sh
```

Copies the extension to `~/.local/share/gnome-shell/extensions/`, compiles the
GSettings schema, installs `touchyweather.desktop` (needed for the GeoClue
permission dialog) and enables it. **On Wayland a brand-new extension is loaded
at login** — log out and back in once; afterwards it appears at the right of the
top bar. `./install.sh --link` symlinks the source tree instead (development — refused
when the tree is on removable media such as this SD card, because `/run/media`
mounts *after* login and a dangling link is silently skipped by the Shell);
`./install.sh --uninstall` removes it (data under `~/.local/share/touchyweather`
and `~/.cache/touchyweather` is left alone).

Preferences: click the gear in the popover footer, or
`gnome-extensions prefs touchyweather@clickcalickclick.github.io`.

## What maps to what

| Mac | GNOME |
|-----|-------|
| SwiftUI `MenuBarExtra` + popover | `PanelMenu.Button` + `PopupMenu` section holding a 360 px card stack in a `St.ScrollView` (height ≈ ½ the display) |
| `WeatherCore` (Swift, Foundation) | `weathercore/` (GJS, GLib/Gio/Soup 3) — same modules, same formulas, same fixtures |
| `URLSession` per timeout class | `Soup.Session` per timeout class (15 s JSON, 6 s NWS, 25 s imagery) |
| CoreLocation | GeoClue 2 (`Geoclue.Simple`, CITY accuracy) via the Shell's own agent; optional keyless IP fallback (BigDataCloud) when Location Services are off — Preferences → General |
| `UNUserNotificationCenter` | `MessageTray.Source` / `Notification`; click → opens the popover. No permission prompt on GNOME (Do Not Disturb is honored by the tray) |
| CoreGraphics radar compositing | Cairo compositing of the same RainViewer 512 px frames; tiles disk-cached under `~/.cache/touchyweather/tiles` |
| SF Symbols | Adwaita symbolic icons; moon phase and the dials are drawn with Cairo |
| `UserDefaults` | GSettings (`org.gnome.shell.extensions.touchyweather`) |
| Application Support JSON files | `~/.local/share/touchyweather/{locations.json, snapshots/, geocode.json, notification-state.json}` — same schemas (`schemaVersion: 1`) |
| `NSBackgroundActivityScheduler` / wake / `NWPathMonitor` | 15-min `GLib` tick / logind `PrepareForSleep` / `Gio.NetworkMonitor` |
| Settings window (⌘,) | libadwaita preferences window (`prefs.js`) |
| Quit (power button) | Disables the extension |
| `secrets.json` in the bundle | `TW_PROXY_KEY`, the `proxy-key` setting, or `~/.config/touchyweather/secrets.json` |

### Deliberate divergences

- **Basemap: Esri Gray Canvas instead of Carto Voyager.** Carto now watermarks
  every keyless raster tile ("API KEY REQUIRED", 2026-09-17), which breaks
  constitution §4. Esri's classic `Canvas/World_{Light,Dark}_Gray_Base` +
  `_Reference` services are keyless and keep the base/labels split, so labels
  still draw above the radar. 256 px tiles at z11 cover the same geography as
  Carto's 512 px @2x at z10 (`RadarTileMath.basePlan(…, zoom=11)`); the dark
  canvas follows the dark Shell (light canvas in the light style) and needs no
  darkening step. Attribution changes accordingly. The Mac app will hit the same
  watermark and should follow.
- **Analytics variant is `"gnome"`** (`api-contract.md §8` — the proxy's
  `track.js` allow-list needs `'gnome'` added; until then pings count as `'app'`).
- **IP-based location fallback** (opt-out, default on): Linux desktops rarely
  have a location sensor and GeoClue itself is usually IP/Wi-Fi based; the
  fallback keeps "weather where I am" working when Location Services are off.
  The spec's "no silent wrong-city default" still holds — it is a real
  best-effort fix, labeled as the current-location entry, never a hardcoded city.
- Saved locations reorder with up/down buttons instead of drag (popup menus and
  drag-and-drop don't mix in the Shell).

## Development

```bash
gjs -m gnome/tests/run.js          # pure-core tests against ../Tests/WeatherCoreTests/Fixtures
gjs -m gnome/tests/live.js         # live pipeline (needs network)
./gnome/install.sh --link          # symlink into the extensions dir
```

To exercise the whole UI without touching your session, run a **headless
Shell** with a virtual monitor; `app/devScreenshots.js` (inert unless the env
var is set) opens the popover, walks the card stack, the locations surface,
search, and a test notification, writing stage screenshots as it goes:

```bash
mkdir -p /tmp/tw-shots
TW_DEV_SCREENSHOT_DIR=/tmp/tw-shots dbus-run-session -- \
  gnome-shell --headless --wayland --virtual-monitor 1400x1000
```

Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i touchyweather`
(look for `JS ERROR`). The popover footer's leaf button is the fault-injection
menu (fail forecast / air quality / pollen / radar / alerts, test notification,
clear cache) — the GNOME twin of the Mac's ladybug menu.
