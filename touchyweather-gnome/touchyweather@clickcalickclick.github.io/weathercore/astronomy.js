// Local astronomy: moon phase and golden/blue-hour times. Verbatim ports of
// `computeMoonPhase()` (index.js:99) and `computeGoldenHour()` (index.js:195),
// the latter a compact port of SunCalc (BSD-2). See data-model.md §§4–5.
// Inputs/outputs are unix seconds; `null` where the sun never reaches an angle.

const SYNODIC_MONTH = 29.530588853;
const MOON_EPOCH_JD = 2451550.1;      // new moon 2000-01-06 18:14 UTC

/** @returns {{phase:number, illumination:number, name1:string, name2:string}} */
export function moonPhase(seconds) {
    const ms = seconds * 1000;
    const jd = ms / 86_400_000 + 2_440_587.5;
    let p = (jd - MOON_EPOCH_JD) / SYNODIC_MONTH;
    p -= Math.floor(p);

    const illumination = Math.round((1 - Math.cos(p * 2 * Math.PI)) * 50);

    let phase, name1, name2;
    if (p < 0.03) [phase, name1, name2] = [0, 'NEW', 'MOON'];
    else if (p < 0.22) [phase, name1, name2] = [1, 'WAXING', 'CRESCENT'];
    else if (p < 0.28) [phase, name1, name2] = [2, 'FIRST', 'QUARTER'];
    else if (p < 0.47) [phase, name1, name2] = [3, 'WAXING', 'GIBBOUS'];
    else if (p < 0.53) [phase, name1, name2] = [4, 'FULL', 'MOON'];
    else if (p < 0.72) [phase, name1, name2] = [5, 'WANING', 'GIBBOUS'];
    else if (p < 0.78) [phase, name1, name2] = [6, 'LAST', 'QUARTER'];
    else if (p < 0.97) [phase, name1, name2] = [7, 'WANING', 'CRESCENT'];
    else [phase, name1, name2] = [0, 'NEW', 'MOON'];
    return {phase, illumination, name1, name2};
}

// ---- SunCalc ---------------------------------------------------------------

const rad = Math.PI / 180;
const dayMs = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const e = rad * 23.4397;   // obliquity

const toJulian = ms => ms / dayMs - 0.5 + J1970;
const fromJulian = j => (Number.isFinite(j) ? (j + 0.5 - J1970) * dayMs : null);
const toDays = ms => toJulian(ms) - J2000;

const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const solarMeanAnomaly = d => rad * (357.5291 + 0.98560028 * d);
function eclipticLongitude(M) {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const P = rad * 102.9372;
    return M + C + P + Math.PI;
}
const julianCycle = (d, lw) => Math.round(d - 0.0009 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h, phi, d) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

/**
 * The four golden/blue-hour milestones for a date and location, in unix
 * seconds (null at polar latitudes — the JS "--:--" fallback).
 * @returns {{blueAM:number|null, goldAM:number|null, goldPM:number|null, bluePM:number|null}}
 */
export function goldenHours(seconds, latitude, longitude) {
    const ms = seconds * 1000;
    const lw = rad * -longitude;
    const phi = rad * latitude;
    const d = toDays(ms);
    const n = julianCycle(d, lw);
    const ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds);
    const L = eclipticLongitude(M);
    const dec = declination(L, 0);
    const Jnoon = solarTransitJ(ds, M, L);

    const getSetJ = h => solarTransitJ(approxTransit(hourAngle(h, phi, dec), lw, n), M, L);
    const timesForAngle = angle => {
        const Jset = getSetJ(angle * rad);
        const Jrise = Jnoon - (Jset - Jnoon);
        const toSec = v => (v === null ? null : v / 1000);
        return {rise: toSec(fromJulian(Jrise)), set: toSec(fromJulian(Jset))};
    };

    const sunrise = timesForAngle(-0.833);
    const blue = timesForAngle(-6);
    const gold = timesForAngle(6);
    return {
        blueAM: blue.rise,      // morning blue hour begins
        goldAM: sunrise.rise,   // morning golden hour begins (sunrise)
        goldPM: gold.set,       // evening golden hour begins
        bluePM: sunrise.set,    // evening blue hour begins (sunset)
    };
}
