#!/bin/bash
# check-fixes.sh - verify every Minisforum V3 SE / CachyOS fix is still in place.
# Run after a system update, a snapper rollback, or whenever something feels off:
#     bash check-fixes.sh
# Exit code 0 = all good, 1 = something needs attention. No root needed.
# See "CachyLinux Build Instructions.md" for what each item is and how to restore it.

ok=0; bad=0
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; ok=$((ok+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n       -> %s\n' "$1" "$2"; bad=$((bad+1)); }
warn() { printf '  \033[33mWARN\033[0m %s\n       -> %s\n' "$1" "$2"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

hdr "1. Accelerometer / auto-rotate (DSDT override)  [doc §3]"
[ -s /etc/initcpio/acpi_override/minisforum_v3se_dsdt.aml ] \
  && pass "override table present: /etc/initcpio/acpi_override/minisforum_v3se_dsdt.aml" \
  || fail "override table missing" "install from rebuild-kit/etc/initcpio/acpi_override/, then: sudo limine-mkinitcpio"
grep -qE '^HOOKS=\(base systemd acpi_override' /etc/mkinitcpio.conf \
  && pass "acpi_override hook in /etc/mkinitcpio.conf (right after 'base systemd')" \
  || fail "acpi_override hook missing from HOOKS in /etc/mkinitcpio.conf" "re-add it after 'base systemd' (check for a .pacnew that replaced the file), then: sudo limine-mkinitcpio"
[ -e /etc/mkinitcpio.conf.pacnew ] && warn "/etc/mkinitcpio.conf.pacnew exists" "merge it by hand (keep the acpi_override hook); never just replace the file"
journalctl -k -b --no-pager 2>/dev/null | grep -q "ACPI: Table Upgrade: override \[DSDT" \
  && pass "kernel accepted the DSDT override this boot" \
  || fail "kernel did not load the override this boot" "initramfs may be stale: sudo limine-mkinitcpio && reboot (Secure Boot must be off)"
[ -s /etc/udev/hwdb.d/61-sensor-minisforum-v3.hwdb ] \
  && pass "mount-matrix hwdb present" \
  || fail "hwdb file missing: /etc/udev/hwdb.d/61-sensor-minisforum-v3.hwdb" "install from rebuild-kit, then: sudo systemd-hwdb update"
if ls /sys/bus/iio/devices/iio:device*/name >/dev/null 2>&1 && cat /sys/bus/iio/devices/iio:device*/name | grep -q lsm6ds3tr-c_accel; then
  pass "accelerometer device present (lsm6ds3tr-c_accel)"
  dev=$(grep -l lsm6ds3tr-c_accel /sys/bus/iio/devices/iio:device*/name | head -1 | xargs dirname)
  udevadm info -q property "$dev" 2>/dev/null | grep -q '^ACCEL_MOUNT_MATRIX=-1, 0, 0; 0, -1, 0; 0, 0, -1' \
    && pass "mount matrix applied to the sensor" \
    || fail "mount matrix not applied (rotation will be inverted)" "sudo systemd-hwdb update && sudo udevadm trigger"
else
  fail "no accelerometer in /sys/bus/iio/devices" "DSDT override not active - see the items above"
fi
systemctl is-active -q iio-sensor-proxy && pass "iio-sensor-proxy running" || warn "iio-sensor-proxy not running" "starts on demand; run 'monitor-sensor' to test"

hdr "2. Internal microphone (HDA pin patch)  [doc §4]"
[ -s /usr/lib/firmware/hda-minisforum-v3se.fw ] && grep -q '0x19 0x04a19150' /usr/lib/firmware/hda-minisforum-v3se.fw \
  && pass "patch firmware present: /usr/lib/firmware/hda-minisforum-v3se.fw" \
  || fail "patch firmware missing or altered" "install from rebuild-kit/usr/lib/firmware/, reboot"
grep -qs 'patch=hda-minisforum-v3se.fw' /etc/modprobe.d/minisforum-audio.conf \
  && pass "modprobe option present: /etc/modprobe.d/minisforum-audio.conf" \
  || fail "modprobe option missing" "install from rebuild-kit/etc/modprobe.d/, reboot"
journalctl -k -b --no-pager 2>/dev/null | grep -q "Applying patch firmware 'hda-minisforum-v3se.fw'" \
  && pass "kernel applied the patch this boot" \
  || fail "kernel did not apply the patch this boot" "check the two items above, then reboot"
card=$(grep -l "ALC245" /proc/asound/card*/codec#0 2>/dev/null | head -1 | sed -E 's#/proc/asound/card([0-9]+)/.*#\1#')
if [ -n "$card" ]; then
  if amixer -c "$card" cget name='Capture Source' >/dev/null 2>&1; then
    pass "ALC245 exposes 'Capture Source' (auto-mic disabled) on card $card"
    amixer -c "$card" cget name='Capture Source' | grep -q ': values=0' \
      && pass "Capture Source = Internal Mic" \
      || warn "Capture Source is set to the headset jack" "GNOME Settings -> Sound -> Input -> Internal Microphone"
  else
    fail "no 'Capture Source' control - the pin patch is not in effect" "see items above"
  fi
else
  fail "ALC245 codec not found in /proc/asound" "audio driver problem, not a fix issue"
fi
vol=$(pactl get-source-volume @DEFAULT_SOURCE@ 2>/dev/null | grep -oE '[0-9]+%' | head -1)
case "${vol%\%}" in
  ''|*[!0-9]*) warn "could not read the input level" "is PipeWire running?";;
  *) if [ "${vol%\%}" -ge 20 ] && [ "${vol%\%}" -le 34 ]; then pass "input level $vol (recommended 25-30 %)"; else warn "input level $vol" "recommended 30 %; >=35 % clips loud speech, <20 % is quiet"; fi;;
esac

hdr "3. Touchpad disable-while-typing  [doc §5]"
[ -x /usr/local/bin/touchpad-dwt.py ] && pass "daemon script present: /usr/local/bin/touchpad-dwt.py" \
  || fail "daemon script missing" "install from rebuild-kit/usr/local/bin/ (chmod +x)"
systemctl is-enabled -q touchpad-dwt.service 2>/dev/null && pass "touchpad-dwt.service enabled" \
  || fail "touchpad-dwt.service not enabled" "install unit from rebuild-kit/etc/systemd/system/, sudo systemctl enable --now touchpad-dwt"
systemctl is-active -q touchpad-dwt.service 2>/dev/null && pass "touchpad-dwt.service running" \
  || fail "touchpad-dwt.service not running" "sudo systemctl start touchpad-dwt; journalctl -u touchpad-dwt"

hdr "4. GPU firmware (DMCUB regression check)  [doc §2]"
n=$(journalctl -k -b --no-pager 2>/dev/null | grep -c "DMCUB error")
[ "$n" -eq 0 ] && pass "no DMCUB errors this boot (linux-firmware $(pacman -Q linux-firmware-amdgpu 2>/dev/null | awk '{print $2}'))" \
  || fail "$n DMCUB error lines this boot - firmware regression" "downgrade: sudo pacman -U /var/cache/pacman/pkg/linux-firmware-amdgpu-<last-good>.pkg.tar.zst"

hdr "5. Fingerprint  [doc §1]"
timeout 15 fprintd-list "$USER" 2>/dev/null | grep -q "Goodix" \
  && { timeout 15 fprintd-list "$USER" 2>/dev/null | grep -q "no fingers" && warn "reader found but no finger enrolled" "GNOME Settings -> Users -> Fingerprint Login" || pass "Goodix reader found, finger(s) enrolled"; } \
  || warn "fprintd could not list the reader" "systemctl status fprintd"

hdr "6. Vocalinux dictation  [doc §6]"
[ -x "$HOME/.local/opt/vocalinux/Vocalinux.AppImage" ] && pass "AppImage present" || fail "AppImage missing: ~/.local/opt/vocalinux/Vocalinux.AppImage" "doc §6b"
[ -s "$HOME/.local/share/vocalinux/models/whispercpp/ggml-small.en.bin" ] && pass "small.en model present" || fail "model missing" "doc §6d"
grep -qs 'Vocalinux.AppImage --start-minimized' "$HOME/.config/autostart/vocalinux.desktop" \
  && pass "autostart entry points at the AppImage" \
  || fail "autostart entry missing or rewritten with a /tmp/.mount path" "restore rebuild-kit/home/.config/autostart/vocalinux.desktop (fix /home/USER)"
gnome-extensions list --enabled 2>/dev/null | grep -q appindicatorsupport && pass "AppIndicator extension enabled (top-bar icon)" \
  || fail "AppIndicator extension not enabled" "gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com (log out/in after installing the package)"
[ "$(gsettings get org.gnome.desktop.input-sources mru-sources 2>/dev/null)" != "@a(ss) []" ] \
  && pass "GNOME mru-sources seeded (IBus text injection can restore the layout)" \
  || fail "GNOME mru-sources empty - dictated text will only reach the clipboard" "gsettings set org.gnome.desktop.input-sources mru-sources \"[('xkb', 'us')]\""
id -nG 2>/dev/null | tr ' ' '\n' | grep -qx input && pass "user in 'input' group (Right-Alt push-to-talk)" \
  || warn "user not in 'input' group" "only needed for the Right-Alt shortcut: sudo usermod -aG input \$USER, then log out/in"
pgrep -f "python3 -m vocalinux.mai[n]" >/dev/null && pass "Vocalinux running" || warn "Vocalinux not running" "launch it from the app menu (autostarts at login)"

hdr "7. Package sanity"
for p in acpica iio-sensor-proxy gnome-shell-extension-appindicator fuse2 wl-clipboard; do
  pacman -Q "$p" >/dev/null 2>&1 && pass "package $p installed" || fail "package $p missing" "sudo pacman -S --needed $p"
done
pn=$(find /etc -name '*.pacnew' 2>/dev/null | wc -l)
[ "$pn" -gt 0 ] && warn "$pn .pacnew file(s) under /etc" "review with 'pacdiff'; merge, don't blindly replace (especially /etc/mkinitcpio.conf)"

printf '\n\033[1mSummary:\033[0m %d OK, %d FAIL\n' "$ok" "$bad"
[ "$bad" -eq 0 ]
