#!/usr/bin/env python3
"""Disable-while-typing for the Minisforum V3 SE keyboard cover.

The cover's touchpad is exposed as a plain relative USB mouse (no touch
data), so libinput cannot do palm rejection or disable-while-typing for it.
This daemon watches the cover's keyboard and, for TIMEOUT_MS after every
non-modifier key press, grabs the touchpad device at the kernel level so its
movement/clicks are discarded. Modifier-only presses (Ctrl/Shift/Alt/Super)
do not trigger it, so Ctrl+click and Shift+drag keep working.
"""
import fcntl, os, select, struct, sys, time

KBD   = "/dev/input/by-id/usb-HS-V3_SE_-US-01-06-02_USB_Keyboard-event-kbd"
MOUSE = "/dev/input/by-id/usb-HS-V3_SE_-US-01-06-02_USB_Keyboard-if01-event-mouse"
TIMEOUT_MS = int(os.environ.get("TIMEOUT_MS", "350"))

EVIOCGRAB = 0x40044590
EV_KEY = 0x01
MODIFIERS = {29, 97, 42, 54, 56, 100, 125, 126}   # L/R ctrl, shift, alt, meta
EVENT_FMT = "llHHi"                                # struct input_event (x86_64)
EVENT_SIZE = struct.calcsize(EVENT_FMT)

def log(msg):
    print(msg, flush=True)

def open_dev(path):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    return fd

def main():
    grabbed = False
    kfd = mfd = None
    release_at = 0.0
    log(f"touchpad-dwt: timeout {TIMEOUT_MS} ms")
    while True:
        # (re)open devices; the cover may be detached
        if kfd is None or mfd is None:
            try:
                if kfd is None: kfd = open_dev(KBD)
                if mfd is None: mfd = open_dev(MOUSE)
                log("touchpad-dwt: devices opened")
            except OSError:
                for fd in (kfd, mfd):
                    if fd is not None:
                        try: os.close(fd)
                        except OSError: pass
                kfd = mfd = None
                grabbed = False
                time.sleep(1.0)
                continue
        timeout = None
        if grabbed:
            timeout = max(0.0, release_at - time.monotonic())
        try:
            r, _, _ = select.select([kfd, mfd], [], [], timeout)
        except OSError:
            r = []
        now = time.monotonic()
        try:
            if kfd in r:
                data = os.read(kfd, EVENT_SIZE * 64)
                for off in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                    _, _, etype, code, value = struct.unpack_from(EVENT_FMT, data, off)
                    if etype == EV_KEY and value in (1, 2) and code not in MODIFIERS:
                        release_at = now + TIMEOUT_MS / 1000.0
                        if not grabbed:
                            fcntl.ioctl(mfd, EVIOCGRAB, 1)
                            grabbed = True
            if mfd in r:
                os.read(mfd, EVENT_SIZE * 64)   # drain (discarded while grabbed)
            if grabbed and time.monotonic() >= release_at:
                fcntl.ioctl(mfd, EVIOCGRAB, 0)
                grabbed = False
        except BlockingIOError:
            pass
        except OSError as e:
            log(f"touchpad-dwt: device error ({e}), reopening")
            for fd in (kfd, mfd):
                try: os.close(fd)
                except OSError: pass
            kfd = mfd = None
            grabbed = False

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
