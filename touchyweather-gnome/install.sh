#!/usr/bin/env bash
# Install (or update) the TouchyWeather GNOME Shell extension for the current
# user: copies the extension into ~/.local/share/gnome-shell/extensions,
# compiles its GSettings schema, installs the .desktop file the GeoClue agent
# needs to show the location permission dialog, and enables the extension.
#
#   ./install.sh            # copy + enable
#   ./install.sh --link     # symlink the source tree instead (development)
#   ./install.sh --uninstall
#
# On Wayland a brand-new extension is only picked up at the next login; later
# updates take effect after `gnome-extensions disable/enable` or a re-login.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="touchyweather@clickcalickclick.github.io"
SRC="$HERE/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST" "$APPS/touchyweather.desktop"
    update-desktop-database "$APPS" 2>/dev/null || true
    echo "Removed $DEST (data in ~/.local/share/touchyweather and ~/.cache/touchyweather left in place)"
    exit 0
fi

# Sanity: the pure core must pass its fixture tests before we touch the Shell.
if command -v gjs >/dev/null; then
    gjs -m "$HERE/tests/run.js" >/dev/null || { echo "core tests failed — not installing"; exit 1; }
fi

mkdir -p "$(dirname "$DEST")" "$APPS"
rm -rf "$DEST"
if [[ "${1:-}" == "--link" ]]; then
    # A symlink onto removable media (/run/media, /media, /mnt) is dangling
    # when the Shell scans extensions at login — udisks mounts later — so the
    # extension silently never loads. Refuse; a copy is the safe default.
    case "$SRC" in
        /run/media/*|/media/*|/mnt/*)
            echo "Refusing --link: $SRC is on removable media, which mounts after login; use a plain ./install.sh (copy)." >&2
            exit 1 ;;
    esac
    ln -s "$SRC" "$DEST"
    echo "Linked $DEST -> $SRC"
else
    cp -r "$SRC" "$DEST"
    echo "Copied to $DEST"
fi
glib-compile-schemas "$DEST/schemas"

install -m 644 "$HERE/touchyweather.desktop" "$APPS/touchyweather.desktop"
update-desktop-database "$APPS" 2>/dev/null || true

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Enabled $UUID"
else
    # The running Shell only knows extensions present at login, so the CLI
    # refuses a brand-new UUID. Add it to the setting directly: the next login
    # (and any nested dev Shell) picks it up.
    python3 - "$UUID" <<'PY'
import sys, subprocess, ast
uuid = sys.argv[1]
cur = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions']).decode().replace('@as ', ''))
if uuid not in cur:
    cur.append(uuid)
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(cur)])
PY
    echo "Added $UUID to enabled-extensions. New extensions are loaded at login on Wayland — log out and back in, then it appears in the top bar."
fi
echo
echo "Then: click the weather item on the right of the top bar. Preferences: gnome-extensions prefs $UUID"
echo "Tip for development: dbus-run-session -- gnome-shell --nested --wayland   (runs a nested Shell with the extension)"
