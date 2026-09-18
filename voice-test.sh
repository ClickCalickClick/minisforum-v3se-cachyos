#!/bin/bash
# Voice level test for the Minisforum V3 SE internal mic.
# For each GNOME input-slider setting: records 6 s, plays it back, prints levels.
# Clips are saved in ./voice-tests/ so you can replay them later.
# Usage:  bash voice-test.sh            (tests 40 50 60 70 %)
#         bash voice-test.sh 45 55 65   (your own list of slider percentages)
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p voice-tests
LEVELS=("$@"); [ ${#LEVELS[@]} -eq 0 ] && LEVELS=(40 50 60 70)
SRC=$(pactl get-default-source)
echo "Source: $SRC"
echo "Levels to test: ${LEVELS[*]} %"
echo

analyze() {
python3 - "$1" <<'EOF'
import wave,struct,math,sys
w=wave.open(sys.argv[1]); n=w.getnframes(); d=w.readframes(n)
s=struct.unpack('<%dh'%(len(d)//2), d); L=s[0::2]
peak=max(abs(x) for x in L); rms=(sum(x*x for x in L)/len(L))**0.5
step=6000; env=[(sum(v*v for v in L[i:i+step])/step)**0.5 for i in range(0,len(L),step)]
db=lambda x: 20*math.log10(max(x,1)/32768)
clip=sum(1 for v in L if abs(v)>=32000)/len(L)*100
verdict = "TOO HOT (clipping)" if clip>0.1 else ("hot" if db(peak)>-3 else ("good" if db(peak)>-14 else ("a bit quiet" if db(peak)>-22 else "too quiet")))
print(f"   peak {db(peak):6.1f} dBFS | speech avg {db(rms):6.1f} dBFS | quietest slice {db(min(env)):6.1f} dBFS | clipped {clip:.1f}%  ->  {verdict}")
EOF
}

for v in "${LEVELS[@]}"; do
  pactl set-source-volume "$SRC" "${v}%"
  sleep 0.5
  c=$(amixer -c 1 sget Capture | grep -oE '\[-?[0-9.]+dB\]' | head -1)
  b=$(amixer -c 1 sget 'Internal Mic Boost' | grep -oE '\[-?[0-9.]+dB\]' | head -1)
  f="voice-tests/slider-${v}.wav"
  echo "=================================================================="
  echo "  Slider ${v}%   (codec: Capture $c + Boost $b)"
  echo "=================================================================="
  for i in 3 2 1; do echo -n "  $i... "; sleep 1; done; echo
  echo "  >>> SPEAK NORMALLY for 6 seconds - say a full sentence, pause, say another <<<"
  timeout 8 pw-record --target "$SRC" --rate 48000 --channels 2 --format s16 "$f" &
  sleep 6.5; kill %1 2>/dev/null; wait 2>/dev/null
  echo "  ...recorded. Playing it back:"
  pw-play "$f" 2>/dev/null
  analyze "$f"
  echo
done

echo "Clips saved in: $(pwd)/voice-tests/"
echo "Replay any clip with:   pw-play voice-tests/slider-60.wav"
echo
read -rp "Which slider % sounded best? (Enter a number, or just Enter to keep 60): " pick
pick=${pick:-60}
pactl set-source-volume "$SRC" "${pick}%"
echo "Input slider set to ${pick}% - WirePlumber will remember it across reboots."
