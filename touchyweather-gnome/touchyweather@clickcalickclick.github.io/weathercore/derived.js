// Metrics derived from raw forecast arrays: rain-alert minutes and the European
// pollen UPI conversion (index.js:479 and :149). See data-model.md §§5–6.

/**
 * Minutes until the next *measurable* precipitation, scanning hour offsets
 * 0...6 from the current hour. Offset 0 reports 15; later offsets `offset*60`.
 * null when none in the window. Verbatim port of index.js:479–485.
 */
export function rainAlertMinutes(amountsFromNow) {
    for (let j = 0; j <= 6; j++) {
        if (j >= amountsFromNow.length) break;
        const tenths = Math.round((amountsFromNow[j] ?? 0) * 10);
        if (tenths > 0) return j === 0 ? 15 : j * 60;
    }
    return null;
}

/** CAMS grains/m³ → 0..5 UPI (max across species); null when every input is null. */
export function pollenUPI({grass, birch, alder, ragweed, mugwort, olive}) {
    const nil = v => v === null || v === undefined;
    const grassScale = v => {
        if (nil(v)) return -1;
        if (v <= 0) return 0; if (v <= 5) return 1;
        if (v <= 20) return 2; if (v <= 50) return 3;
        if (v <= 200) return 4; return 5;
    };
    const treeScale = v => {
        if (nil(v)) return -1;
        if (v <= 0) return 0; if (v <= 15) return 1;
        if (v <= 50) return 2; if (v <= 100) return 3;
        if (v <= 300) return 4; return 5;
    };
    const weedScale = v => {
        if (nil(v)) return -1;
        if (v <= 0) return 0; if (v <= 5) return 1;
        if (v <= 15) return 2; if (v <= 50) return 3;
        if (v <= 200) return 4; return 5;
    };
    const vals = [
        grassScale(grass), treeScale(birch), treeScale(alder),
        weedScale(ragweed), weedScale(mugwort), treeScale(olive),
    ];
    const max = Math.max(...vals);
    return max < 0 ? null : max;
}

/** CAMS pollen coverage box. Port of `isEurope()` (index.js:135). */
export function isEurope(latitude, longitude) {
    return latitude >= 35 && latitude <= 72 && longitude >= -25 && longitude <= 45;
}
