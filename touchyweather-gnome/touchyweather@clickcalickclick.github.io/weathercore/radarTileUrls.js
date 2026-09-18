/**
 * Tile URL builders for the radar card's three layers (keyless public CDNs).
 *
 * Basemap divergence from the Mac (api-contract.md §7): Carto began
 * watermarking every keyless raster tile ("API KEY REQUIRED", checked
 * 2026-09-17), which breaks constitution §4 (keyless or proxied). The GNOME
 * port uses Esri's classic Gray Canvas services instead — the same base +
 * reference (labels) split, so labels still draw above the radar — at 256 px
 * / z11, which covers the same geography as Carto's 512 px @2x / z10.
 * Attribution: Esri, HERE, Garmin, © OpenStreetMap contributors.
 */
export const RadarTileURLs = {
    /** Zoom for the 256 px canvas tiles; same px-per-degree as 512 px @ z10. */
    basemapZoom: 11,

    /** Muted gray canvas without labels; `style` is 'dark' or 'light'. */
    basemap: (z, x, y, style = 'dark') =>
        `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style === 'light' ? 'Light' : 'Dark'}_Gray_Base/MapServer/tile/${z}/${y}/${x}`,

    /** Transparent label overlay, drawn above the radar for legibility. */
    labels: (z, x, y, style = 'dark') =>
        `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style === 'light' ? 'Light' : 'Dark'}_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,

    /** RainViewer radar tile: color scheme 2 + options 1_1, 512 px variant. */
    radar: (host, framePath, z, x, y) => `${host}${framePath}/512/${z}/${x}/${y}/2/1_1.png`,

    /** Any radar tile at or below this size is RainViewer's placeholder ⇒ empty. */
    radarPlaceholderMaxBytes: 3500,

    attribution: 'Map: Esri, HERE, Garmin, © OpenStreetMap · RainViewer',
};
