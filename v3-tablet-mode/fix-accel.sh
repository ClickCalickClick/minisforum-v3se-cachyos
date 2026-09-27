#!/bin/sh
# Run with: sudo sh v3-tablet-mode/fix-accel.sh
set -e
cd "$(dirname "$0")"
install -m 644 81-v3-accel-poll.rules /etc/udev/rules.d/81-v3-accel-poll.rules
systemctl stop iio-sensor-proxy.service
for d in /sys/bus/iio/devices/iio:device*; do
  [ "$(cat "$d/name")" = lsm6ds3tr-c_accel ] || continue
  echo 0 > "$d/buffer/enable"
  udevadm control --reload
  udevadm trigger --action=change --settle "$d"
  echo "$d: $(udevadm info "$d" | grep IIO_SENSOR_PROXY_TYPE)"
done
systemctl start iio-sensor-proxy.service
