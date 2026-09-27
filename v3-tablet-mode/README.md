# Tablet mode, auto-rotate and on-screen keyboard (original Minisforum V3)

Fixes three problems I hit on the **original V3** (Ryzen 7 8840U, board HPPAC,
cover USB `05af:326a`) under GNOME 50 once the accelerometer DSDT override was
in place:

| Symptom | Cause | Fix here |
|---|---|---|
| Cover detached, but no auto-rotate and no on-screen keyboard | The V3's tablet-mode switch (ACPI `ID9001` / `PNP0C60`, one hall sensor on GPIO 5) only flips when the cover is **folded back**, not when it's **detached**. With a switch present, GNOME trusts only the switch, so it never enters touch mode. | `v3-tablet-mode` service: a virtual switch that's ON when the cover is gone **or** folded back. The real switch is hidden from libinput (`70-v3-tablet-mode.rules`). |
| After reattaching the cover the letter keys are dead (Fn/media keys work) | The real switch can stick at "folded back" after reseating. libinput's Minisforum quirk marks the cover keyboard as internal, so it gets disabled in tablet mode. | The service ignores the real switch after an attach (and at startup) until it toggles again on its own; a real fold-back always toggles it. |
| Rotation freezes (orientation stuck at `normal`), typically after a suspend | The firmware declares the LSM6DS3TR-C FIFO interrupt as **edge**-triggered (`GpioInt (Edge, ActiveHigh)`, amd_gpio pin 9). Once an edge is missed, the line stays asserted and never fires again. iio-sensor-proxy only uses that buffered mode while GNOME has the sensor claimed (i.e. in tablet mode), so it shows up exactly when you need it. | `81-v3-accel-poll.rules` makes iio-sensor-proxy poll the sensor over sysfs instead. It only polls while the sensor is claimed, so no cost in laptop mode. |

The V3 SE doesn't need the service: it has no tablet-mode switch, so GNOME's
fallback ("no pointer device → touch mode") already kicks in when the cover's
touchpad disappears. On a machine without the `ID9001` switch the service just
logs "nothing to do" and exits. The polling rule is harmless on either model.

## Install / remove

```bash
sudo sh v3-tablet-mode/install.sh      # installs, applies immediately, no reboot
sudo sh v3-tablet-mode/uninstall.sh    # then log out/in
```

`install.sh` copies:

- `v3-tablet-mode` → `/usr/local/bin/` (Python 3 stdlib only: uinput + netlink, event-driven, no polling)
- `v3-tablet-mode.service` → `/etc/systemd/system/` (enabled)
- `70-v3-tablet-mode.rules`, `81-v3-accel-poll.rules` → `/etc/udev/rules.d/`

It then re-adds the real switch so libinput drops it, and runs `fix-accel.sh`
(restarts iio-sensor-proxy in polling mode).

## Verify

```bash
journalctl -u v3-tablet-mode -b          # "tablet mode ON/OFF", "real switch -> 0/1", "cover attached"
gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.freedesktop.DBus.Properties.Get org.gnome.Mutter.DisplayConfig PanelOrientationManaged
                                         # true = GNOME is in touch mode and handles rotation
udevadm info /sys/bus/iio/devices/iio:device1 | grep IIO_SENSOR_PROXY_TYPE   # iio-poll-accel
```

Behaviour: cover detached → tablet mode (rotation + on-screen keyboard on finger
taps); cover folded back → tablet mode; cover attached and open → laptop mode.
State changes are debounced by 1 s so a loose pogo contact doesn't flap.

If the letter keys ever die anyway, fold the cover closed and open it again.
