#!/bin/sh
# Run with: sudo sh v3-tablet-mode/install.sh
set -e
cd "$(dirname "$0")"
install -m 755 v3-tablet-mode /usr/local/bin/v3-tablet-mode
install -m 644 v3-tablet-mode.service /etc/systemd/system/v3-tablet-mode.service
install -m 644 70-v3-tablet-mode.rules /etc/udev/rules.d/70-v3-tablet-mode.rules
udevadm control --reload
# Make libinput drop the real switch now (re-add applies LIBINPUT_IGNORE_DEVICE)
for ev in /sys/class/input/event*; do
  case "$(readlink -f "$ev")" in */ID9001:*/gpio-keys*)
    udevadm trigger --action=remove "$ev"; udevadm trigger --action=add "$ev";;
  esac
done
systemctl daemon-reload
systemctl enable v3-tablet-mode.service
systemctl restart v3-tablet-mode.service
sh ./fix-accel.sh
sleep 2
systemctl --no-pager status v3-tablet-mode.service | tail -5
