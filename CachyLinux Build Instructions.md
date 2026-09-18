# CachyOS Build Instructions — Minisforum V3 SE

Complete record of every change made to this machine on 2026-09-17, in the
order it was done, with the reasoning, the exact files, and how to undo each
piece. Written so the system can be rebuilt from a fresh CachyOS install.

A copy of every custom file lives in **`rebuild-kit/`** next to this document,
laid out in the same paths as on the system (`rebuild-kit/etc/...`,
`rebuild-kit/usr/...`, `rebuild-kit/home/...`).

---

## 0. The machine

| | |
|---|---|
| Model | Minisforum **V3 SE** 3-in-1 tablet (board RBPAC, SKU MGRBPAC), BIOS AMI 1.03 (2024-08-26) |
| CPU / GPU | AMD Ryzen 7 7735U (Rembrandt-R) / Radeon 680M (RDNA2 iGPU, `amdgpu`, Vulkan via RADV) |
| RAM / disk | 16 GB LPDDR5 / Kingston OM8PGP4 1 TB NVMe |
| Audio | Realtek ALC245 HDA codec, PCI subsystem ID **1f4c:e001** (shared with the original V3); AMD ACP 6.x coprocessor |
| Wi-Fi / BT | Intel AX210 (Killer AX1675w) |
| Sensors | ST LSM6DS3TR-C accelerometer/gyro (ACPI ID `SMOCF05`) |
| Fingerprint | Goodix 27c6:6092 (in the power button) |
| Keyboard cover | USB 1c4f:00b8 "HS-V3 SE" — touchpad is a plain USB mouse (no touch data) |
| OS | CachyOS (Arch), kernel `linux-cachyos` 7.2.6, GNOME 50.5 on Wayland, PipeWire 1.6.8, Limine bootloader, mkinitcpio 42 |
| Dual boot | Windows 11 on `nvme0n1p3` (BitLocker) — untouched |
| Boot security | Secure Boot **off**, kernel lockdown **none** (required for the ACPI table override) |

Useful identity commands: `hostnamectl`, `cat /sys/devices/virtual/dmi/id/{sys_vendor,product_name,board_name}`,
`lspci -k`, `lsusb`, `cat /proc/asound/cards`.

---

## 1. What works out of the box (no action needed)

- GPU (`amdgpu`), Wi-Fi (`iwlwifi`), Bluetooth (`btusb`), NVMe, SD card reader (`rtsx_pci`), USB4/Thunderbolt, touchscreen + stylus (`i2c_hid_acpi` → `hid-multitouch`), webcams (`uvcvideo`), speakers/headphones (ALC245), TPM, battery/lid/power.
- **Fingerprint reader** — supported by `libfprint` ≥ 1.94.6 (goodixmoc driver). Just enroll:
  GNOME Settings → System → Users → *Fingerprint Login*, or `fprintd-enroll`.
  CachyOS's `chwd` already adds `pam_fprintd.so` to `/etc/pam.d/sudo`; GDM has `/etc/pam.d/gdm-fingerprint`.
- **Tablet mode on keyboard detach** — libinput ≥ 1.26.2 ships `50-system-minisforum.quirks` marking the cover keyboard as internal. No action.

---

## 2. amdgpu DMCUB firmware failure (fixed by an update)

**Symptom:** `journalctl -k` full of `failed to load ucode DMCUB(0x3F)`, `psp gfx command LOAD_IP_FW(0x6) failed … 0xFFFF0008`, `DMCUB error - collecting diagnostic data`; slow boot, USB-C DisplayPort hotplug broken.

**Cause:** regression in `linux-firmware-amdgpu 20260910-1` (broken `yellow_carp_dmcub.bin`). Fixed in 20260910-2 / 20260916-1.

**Fix:**
```bash
sudo pacman -Syu
```
Verify after reboot: `journalctl -k -b | grep -i dmub` → `DMUB hardware initialized`, and
`journalctl -k -b | grep -c "DMCUB error"` → `0`.

If it ever regresses again, downgrade: `sudo pacman -U /var/cache/pacman/pkg/linux-firmware-amdgpu-<good-version>.pkg.tar.zst`.

---

## 3. Accelerometer / auto-rotate (DSDT override)

**Symptom:** no `/sys/bus/iio/devices/`, `monitor-sensor` shows no accelerometer, no auto-rotate.

**Cause:** the BIOS exposes the LSM6DS3TR-C with ACPI ID `SMOCF05`, which the kernel's `st_lsm6dsx` driver doesn't know (it knows `SMO8B30` / `SMOCF00`). An upstream patch adding `SMOCF05` was posted (Samuel Dionne-Riel, Dec 2025 / Feb 2026) but never merged. Same fix as the V3 community uses (awesome-minisforum-v3 issue #2, AUR `minisforum-v3-dsdt`).

**Fix:** override the DSDT so the device is named `SMO8B30`, plus a udev hwdb mount matrix (the sensor is mounted inverted).

### 3a. Prerequisites
```bash
sudo pacman -S --needed acpica iio-sensor-proxy
```
Secure Boot must be off and `cat /sys/kernel/security/lockdown` must show `[none]`, otherwise the kernel ignores table overrides.

### 3b. Build the patched DSDT (or reuse `rebuild-kit/etc/initcpio/acpi_override/minisforum_v3se_dsdt.aml`)
```bash
mkdir -p ~/dsdt && cd ~/dsdt
sudo cat /sys/firmware/acpi/tables/DSDT > dsdt.dat
iasl -d -ve dsdt.dat                       # -> dsdt.dsl
```
Edit `dsdt.dsl` — exactly two changes:
1. Header line: `DefinitionBlock ("", "DSDT", 2, "ALASKA", "A M I ", 0x01072009)` → change `0x01072009` to **`0x01072019`** (bumped OEM revision).
2. In `Scope (\_SB.I2CD)` → `Device (STS)`: change both
   `Name (_HID, EisaId ("SMOCF05"))` and `Name (_CID, EisaId ("SMOCF05"))` to **`"SMO8B30"`**.

```bash
iasl -tc -ve dsdt.dsl                      # -> dsdt.aml (0 errors; warnings are normal)
```
(Do **not** touch `Device (CIND)` / `AMDI0081` — the V3 community patch renames it to `INT33D3`, but on the SE it has no `VGBS` method so that does nothing useful.)

### 3c. Install the override
```bash
sudo install -Dm644 dsdt.aml /etc/initcpio/acpi_override/minisforum_v3se_dsdt.aml
sudo install -Dm644 dsdt.dat /etc/initcpio/acpi_override/src/dsdt.dat.orig   # keep the original
sudo install -Dm644 dsdt.dsl /etc/initcpio/acpi_override/src/dsdt.dsl
```
Add the hook to `/etc/mkinitcpio.conf` — it must come **right after `base systemd`**:
```
HOOKS=(base systemd acpi_override autodetect microcode kms modconf block keyboard sd-vconsole plymouth filesystems)
```

### 3d. Mount matrix
`/etc/udev/hwdb.d/61-sensor-minisforum-v3.hwdb`:
```
# Minisforum V3 / V3 SE - LSM6DS3TR-C accelerometer mount matrix
sensor:modalias:acpi:SMO8B30*:dmi:*svnMicroComputer*:pnV3*
 ACCEL_MOUNT_MATRIX=-1, 0, 0; 0, -1, 0; 0, 0, -1

sensor:modalias:acpi:SMOCF05*:dmi:*svnMicroComputer*:pnV3*
 ACCEL_MOUNT_MATRIX=-1, 0, 0; 0, -1, 0; 0, 0, -1
```
```bash
sudo systemd-hwdb update
```

### 3e. Rebuild initramfs — **use the Limine wrapper, not plain `mkinitcpio -P`**
```bash
sudo limine-mkinitcpio
```
(`mkinitcpio -P` writes `/boot/initramfs-*.img`, but Limine boots from `/boot/<machine-id>/<kernel>/initramfs`; `limine-mkinitcpio` builds and updates `/boot/limine.conf`. Plain `mkinitcpio -P` offers to run it at the end — answer `y`.)

### 3f. Verify after reboot
```bash
journalctl -k -b | grep -E "ACPI: (DSDT .*01072019|Table Upgrade)"   # override accepted
ls /sys/bus/iio/devices/                                          # iio:device0 (gyro) iio:device1 (accel)
udevadm info -q property /sys/bus/iio/devices/iio:device1 | grep MOUNT
monitor-sensor                                                    # tilt the tablet; orientation changes
```
GNOME then shows the auto-rotate toggle in Quick Settings.

### Revert
Remove `acpi_override` from HOOKS (or `sudo cp /etc/mkinitcpio.conf.bak-dsdt /etc/mkinitcpio.conf`), delete `/etc/initcpio/acpi_override/`, `sudo limine-mkinitcpio`.

**Dead end, for the record:** a "v2" DSDT that also added `_WOV` + `AcpDmicConnected` to `\_SB.PCI0.GP17.ACP` made the AMD ACP DMIC machine driver bind, but the PDM data line was stuck low (no mic there). Reverted. The mics are on the Realtek codec (section 4).

---

## 4. Internal microphone (HDA pin-config patch)

**Symptom:** the built-in mic array records only ADC idle noise (~100/32767) at any gain; PipeWire shows "Internal Microphone — not available".

**Root cause (confirmed via the Windows driver: mic = "Microphone Array (Realtek(R) Audio)", parent `HDAUDIO\FUNC_01&VEN_10EC&DEV_0245`):**
the DMIC array is on ALC245 pin **0x12**. The headset-mic jack pin **0x19** has **no wired presence detect** and always reads "plugged" (`GET_PIN_SENSE` = `0x80000000`, same as the unused pin 0x18). The kernel's auto-mic switching therefore routes ADC 0x08 to the empty jack (mixer 0x23: input 0x19 unmuted, 0x12 muted). Windows' Realtek driver ignores that pin's detect; Linux didn't.

**Things that did NOT work (don't retry):** `model=alc256-asus-aio` (the V3 community "fix" — never even applied; codec GPIO bits 0x01/0x02/0x04/0x08 all tested live, no effect), the AMD ACP DMIC path (see 3f), any gain change.

**Fix:** mark pin 0x19 as `NO_PRESENCE` (`0x04a19050` → `0x04a19150`). The generic parser then stops auto-switching and exposes a normal `Capture Source` (Internal Mic / Mic) control that PipeWire drives from its ports. Applied at driver probe time via the kernel's HDA "patch firmware" mechanism (survives kernel updates, keeps the upstream V3 SE bass-speaker quirk).

`/usr/lib/firmware/hda-minisforum-v3se.fw`:
```
# Minisforum V3 SE (ALC245, SSID 1f4c:e001)
[codec]
0x10ec0245 0x1f4ce001 0

[pincfg]
0x19 0x04a19150
```
`/etc/modprobe.d/minisforum-audio.conf`:
```
options snd-hda-intel patch=hda-minisforum-v3se.fw,hda-minisforum-v3se.fw,hda-minisforum-v3se.fw
```
(`patch=` is per sound-card index; listing it three times covers any enumeration order — the `[codec]` header makes it apply only to this exact codec/SSID.)

```bash
sudo install -Dm644 rebuild-kit/usr/lib/firmware/hda-minisforum-v3se.fw /usr/lib/firmware/
sudo install -Dm644 rebuild-kit/etc/modprobe.d/minisforum-audio.conf /etc/modprobe.d/
sudo reboot
```

### Verify
```bash
journalctl -k -b | grep "Applying patch firmware"          # on 0000:e4:00.6
amixer -c 1 cget name="Capture Source"                      # Item #0 'Internal Mic', values=0
pactl list sources | grep -E "Active Port"                  # analog-input-internal-mic
```
Quick level test: `pw-record --rate 48000 --channels 2 --format s16 t.wav` (Ctrl-C after a few seconds), `pw-play t.wav`.

### Level
GNOME Settings → Sound → **Input volume ≈ 30 %** (= Capture +28.5 dB, Boost 0). Measured: normal speech peaks −7 dBFS, no clipping.
Anything ≥ 35 % puts the codec at +30 dB and loud speech clips; the factory default (100 % = +60 dB) is badly distorted.
WirePlumber remembers the slider. `voice-test.sh` in this folder sweeps and plays back settings if it needs re-tuning.

### Side effect
Auto-switching is off, so a headset mic plugged into the jack must be selected manually (Sound → Input → *Microphone*). Whether that jack's mic works at all is untested (V3 owners report it doesn't — same broken detect).

### Upstream
A kernel patch implementing the same pin fixup is in this folder:
`0001-ALSA-hda-realtek-Fix-internal-mic-on-Minisforum-V3-SE.patch` + `HOW-TO-SUBMIT-PATCH.txt`.
If/when it lands in the kernel, delete the two files above; the in-kernel quirk does the same thing.

### Revert
`sudo rm /etc/modprobe.d/minisforum-audio.conf /usr/lib/firmware/hda-minisforum-v3se.fw`, reboot.

---

## 5. Touchpad palm rejection (disable-while-typing daemon)

**Symptom:** cursor jumps while typing when a palm brushes the keyboard-cover touchpad.

**Cause:** the cover's firmware presents the touchpad as a plain relative USB mouse (`EV=17`, `REL` only, no `ABS`/multitouch, `PROP=0`). libinput therefore classifies it as a mouse: no palm detection, no disable-while-typing. Same limitation on Windows. Nothing V3-specific reported anywhere.

**Fix:** a small root daemon that grabs the touchpad device (`EVIOCGRAB`) for 350 ms after each non-modifier key press on the cover keyboard. Modifiers (Ctrl/Shift/Alt/Super) are exempt so Ctrl+click / Shift+drag still work; it survives cover detach/reattach.

Files: `/usr/local/bin/touchpad-dwt.py` (88 lines, Python, no dependencies) and `/etc/systemd/system/touchpad-dwt.service` — both in `rebuild-kit/`.
```bash
sudo install -Dm755 rebuild-kit/usr/local/bin/touchpad-dwt.py /usr/local/bin/touchpad-dwt.py
sudo install -Dm644 rebuild-kit/etc/systemd/system/touchpad-dwt.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now touchpad-dwt.service
```
Device paths it uses (stable `by-id` names): `usb-HS-V3_SE_-US-01-06-02_USB_Keyboard-event-kbd` and `…-if01-event-mouse`.

Tuning: `Environment=TIMEOUT_MS=350` in the unit (raise to 500 if brushes still get through right after typing; lower to 250 if the pad feels sluggish), then `sudo systemctl daemon-reload && sudo systemctl restart touchpad-dwt`.

Verify: `systemctl status touchpad-dwt` → "devices opened". Wiggle a finger on the pad while pressing letter keys — the pointer freezes.

### Revert
`sudo systemctl disable --now touchpad-dwt`.

---

## 6. Voice dictation — Vocalinux (Whisper on the AMD GPU)

**Choice:** Vocalinux 0.17.0 (open source). Picked because it types into the focused app on GNOME Wayland via a real **IBus** engine (GNOME blocks `wtype`-style injection), runs whisper.cpp on the 680M via **Vulkan**, and has a top-bar icon for keyboardless use. Speech Note (Flathub `net.mkiol.SpeechNote`) is the alternative for dictating into its own window.

**Install method: the official AppImage** — the AUR package pulls a CPU-only whisper backend (`python-pywhispercpp-cpu`); the AppImage bundles Vulkan whisper.cpp.

### 6a. Host packages
```bash
sudo pacman -S --needed gnome-shell-extension-appindicator fuse2 wl-clipboard
```
### 6b. AppImage
```bash
mkdir -p ~/.local/opt/vocalinux && cd ~/.local/opt/vocalinux
curl -LO https://github.com/VocaHQ/vocalinux/releases/download/v0.17.0/Vocalinux-0.17.0-x86_64.AppImage
curl -LO https://github.com/VocaHQ/vocalinux/releases/download/v0.17.0/SHA256SUMS
grep Vocalinux-0.17.0-x86_64.AppImage SHA256SUMS | sha256sum -c -
chmod +x Vocalinux-0.17.0-x86_64.AppImage && ln -sfn Vocalinux-0.17.0-x86_64.AppImage Vocalinux.AppImage
```
Icon: `./Vocalinux.AppImage --appimage-extract 'usr/share/icons/hicolor/*/apps/*'` then copy
`squashfs-root/usr/share/icons/hicolor/scalable/apps/vocalinux.svg` to `~/.local/share/icons/hicolor/scalable/apps/`.

### 6c. Launcher + autostart (both in `rebuild-kit/home/`)
- `~/.local/share/applications/vocalinux.desktop` — app-menu entry, `Exec=/home/USER/.local/opt/vocalinux/Vocalinux.AppImage`
- `~/.config/autostart/vocalinux.desktop` — `Exec=… Vocalinux.AppImage --start-minimized`

**Gotcha:** if you ever toggle "Autostart" inside Vocalinux's own menu, it rewrites the autostart file with its temporary `/tmp/.mount_Vocali…` path, which breaks at next login. Don't touch that toggle; restore the file from `rebuild-kit/` if it happens.

### 6d. Model (English small, ~465 MB) — the first-run wizard was skipped, so fetched directly
```bash
mkdir -p ~/.local/share/vocalinux/models/whispercpp && cd ~/.local/share/vocalinux/models/whispercpp
curl -L -o ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.en.bin
echo "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d  ggml-small.en.bin" | sha256sum -c -
```
(That commit hash and digest are what Vocalinux 0.17.0 pins; a mismatch makes it refuse the model.)

### 6e. Config — `~/.config/vocalinux/config.json` (full copy in `rebuild-kit/`). Keys that matter:
```json
"speech_recognition": { "engine": "whisper_cpp", "language": "en-us",
                        "whisper_cpp_model_size": "small.en", "whisper_cpp_model_variant": "small.en" },
"shortcuts": { "toggle_recognition": "right_alt+right_alt", "mode": "push_to_talk" },
"general":   { "autostart": true, "first_run": false },
"ui":        { "start_minimized": true }
```
Gotchas found the hard way: the language key is **`en-us`**, not `en` (otherwise it loads the multilingual model); and **stop the app before editing the file** — it writes its in-memory config back on exit.

### 6f. GNOME integration
```bash
gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com     # after a log-out/in following the package install
gsettings set org.gnome.desktop.input-sources mru-sources "[('xkb', 'us')]"
sudo usermod -aG input $USER                                    # then log out/in
```
- The extension gives the top-bar microphone icon (tap → Start/Stop dictation).
- `mru-sources`: Vocalinux's IBus injector needs a "restorable" engine and reads GNOME's most-recently-used input-source list, which is empty on a single-layout machine → injection failed and text only went to the clipboard. Seeding it with the one layout fixes that.
- `input` group: needed for the Right-Alt push-to-talk on Wayland (evdev). Trade-off: any process running as the user can then read raw keystrokes. Touch/tap use works without it.

### 6g. Verify
```bash
journalctl --user -b | grep -iE "vulkan backend|model loaded|StatusNotifier|inject"
```
Expect `whisper.cpp model loaded in ~1.0s (vulkan backend)`, `ggml_vulkan: … RADV REMBRANDT`, no "StatusNotifierWatcher" warning.
Use: hold **Right Alt** (the one right of the space bar), speak, release → text appears at the cursor. Or tap the top-bar icon → Start dictation … Stop dictation.

### Revert
`rm -rf ~/.local/opt/vocalinux ~/.local/share/vocalinux ~/.config/vocalinux ~/.config/autostart/vocalinux.desktop ~/.local/share/applications/vocalinux.desktop`; `sudo gpasswd -d $USER input`.

---

## 7. Rebuild-from-scratch checklist

1. Install CachyOS (GNOME), keep Secure Boot **off**. `sudo pacman -Syu`.
2. Enroll fingerprint (section 1).
3. Copy `rebuild-kit/` to the machine, then:
   ```bash
   cd rebuild-kit
   sudo pacman -S --needed acpica iio-sensor-proxy gnome-shell-extension-appindicator fuse2 wl-clipboard
   sudo install -Dm644 etc/initcpio/acpi_override/minisforum_v3se_dsdt.aml /etc/initcpio/acpi_override/minisforum_v3se_dsdt.aml
   sudo install -Dm644 etc/udev/hwdb.d/61-sensor-minisforum-v3.hwdb /etc/udev/hwdb.d/
   sudo install -Dm644 usr/lib/firmware/hda-minisforum-v3se.fw /usr/lib/firmware/
   sudo install -Dm644 etc/modprobe.d/minisforum-audio.conf /etc/modprobe.d/
   sudo install -Dm755 usr/local/bin/touchpad-dwt.py /usr/local/bin/
   sudo install -Dm644 etc/systemd/system/touchpad-dwt.service /etc/systemd/system/
   sudo sed -i -E 's/^HOOKS=\((base systemd)/HOOKS=(\1 acpi_override/' /etc/mkinitcpio.conf
   sudo systemd-hwdb update
   sudo systemctl daemon-reload && sudo systemctl enable --now touchpad-dwt.service
   sudo limine-mkinitcpio
   ```
   **Caveat:** the `.aml` was built from BIOS 1.03's DSDT. If the BIOS is ever updated, rebuild it from the new table (section 3b) — an override built from a different BIOS's DSDT can break boot (worst case: remove `acpi_override` from HOOKS from a live USB or Limine snapshot and rebuild).
4. Reboot. Verify sections 2, 3f, 4 and 5.
5. Vocalinux: sections 6a–6f, then log out/in. Copy `rebuild-kit/home/` files into `~` (fix the username in the two `.desktop` files (they say `USER`)).
6. GNOME Sound → Input volume → 30 %.

---

## 8. Files in this folder

| File | What |
|---|---|
| `rebuild-kit/` | exact copies of every custom file, in system layout |
| `0001-ALSA-hda-realtek-Fix-internal-mic-on-Minisforum-V3-SE.patch` | upstream kernel patch for the mic (section 4) |
| `HOW-TO-SUBMIT-PATCH.txt` | how to send it with `git send-email` |
| `voice-test.sh` | mic level sweep with playback (`bash voice-test.sh 20 25 30`) |
| `voice-tests/`, `mic-*.wav` | recordings from the level tuning |
| `WINDOWS-MIC-INVESTIGATION-INSTRUCTIONS.txt`, `Collect-AudioInfo.ps1`, `windows-audio-report/` | the Windows-side investigation that proved the mic is on the codec (report contains Windows registry exports — delete if not wanted) |

## 9. Versions at the time of writing
`linux-cachyos 7.2.6-1`, `linux-firmware 20260916-1`, `libfprint 1.94.100`, `libinput 1.31.3`, `iio-sensor-proxy 3.9`, `pipewire 1.6.8`, `wireplumber 0.5.17`, `mkinitcpio 42`, `acpica 20251212`, `gnome-shell-extension-appindicator 65`, Vocalinux 0.17.0.

SHA256 of the custom files (to check a rebuild copied them intact):
```
c2aa3f2fc0cd59ef998239682f4505393aef63a8f9f9996c28824efcfbc86a9b  /usr/lib/firmware/hda-minisforum-v3se.fw
01f9f0e758f0e5177a59b7da8f4ec2a828f73a4d3e3814cc2369ced13ccbb3e2  /etc/udev/hwdb.d/61-sensor-minisforum-v3.hwdb
af13e7d3740b5f98bad8a26f49c72036dc67b38c67c49d12364d5f70e53ae060  /usr/local/bin/touchpad-dwt.py
7a0d3ca885bd9c60cc7adf4f4905e0bb64c09271eb6ff6aeb1e03f9499fcdace  /etc/initcpio/acpi_override/minisforum_v3se_dsdt.aml
```
