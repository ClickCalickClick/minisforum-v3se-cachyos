#!/bin/sh
# Run with: sudo sh v3-tablet-mode/uninstall.sh  (then log out/in)
systemctl disable --now v3-tablet-mode.service
rm -f /usr/local/bin/v3-tablet-mode /etc/systemd/system/v3-tablet-mode.service \
      /etc/udev/rules.d/70-v3-tablet-mode.rules /etc/udev/rules.d/81-v3-accel-poll.rules
systemctl daemon-reload
udevadm control --reload
# Hand the real switch back to libinput and let iio-sensor-proxy pick its default mode
for ev in /sys/class/input/event*; do
  case "$(readlink -f "$ev")" in */ID9001:*/gpio-keys*)
    udevadm trigger --action=remove "$ev"; udevadm trigger --action=add "$ev";;
  esac
done
udevadm trigger --action=change --subsystem-match=iio --settle
systemctl restart iio-sensor-proxy.service
