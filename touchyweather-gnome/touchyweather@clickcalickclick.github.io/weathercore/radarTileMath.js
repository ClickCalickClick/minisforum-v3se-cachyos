// Web-Mercator tile geometry for the radar card (RadarTileMath.swift; ported
// from the Pebble proxy's radar.js). Emits tile coordinates and destination
// rects in output-image pixel space; the app does the Cairo drawing.

export const RadarTileMath = {
    outputSize: 1024,   // output image edge, px
    baseZoom: 10,       // Carto basemap/labels zoom
    radarZoom: 7,       // RainViewer caps at z7
    tilePixels: 512,    // every source tile is 512 px

    /** Fractional web-Mercator tile coordinate for lon/lat at zoom z. */
    lonLatToTileXY(lon, lat, z) {
        const n = 2 ** z;
        const x = ((lon + 180) / 360) * n;
        const latRad = lat * Math.PI / 180;
        const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
        return {x, y};
    },

    /** Tile plan for a layer at `zoom`, sharing the base-zoom window geometry. */
    plan(lat, lon, zoom, output = this.outputSize) {
        const tilesAcrossBase = output / this.tilePixels;
        const tilesAcross = tilesAcrossBase * 2 ** (zoom - this.baseZoom);
        const pxPerTile = output / tilesAcross;

        const center = this.lonLatToTileXY(lon, lat, zoom);
        const left = center.x - tilesAcross / 2;
        const top = center.y - tilesAcross / 2;
        const right = center.x + tilesAcross / 2;
        const bottom = center.y + tilesAcross / 2;

        const eps = 1e-9;
        const txMin = Math.floor(left + eps);
        const txMax = Math.floor(right - eps);
        const tyMin = Math.floor(top + eps);
        const tyMax = Math.floor(bottom - eps);

        const placements = [];
        for (let ty = tyMin; ty <= tyMax; ty++) {
            for (let tx = txMin; tx <= txMax; tx++) {
                placements.push({
                    tileX: tx, tileY: ty,
                    destX: (tx - left) * pxPerTile,
                    destY: (ty - top) * pxPerTile,
                    destSize: pxPerTile,
                });
            }
        }
        return {zoom, placements};
    },

    /**
     * Basemap/labels window. `zoom` defaults to the 512 px reference zoom;
     * a 256 px provider passes baseZoom+1 and gets one tile per 256 px —
     * the same geography, the same pixel density.
     */
    basePlan(lat, lon, output = this.outputSize, zoom = this.baseZoom) {
        return this.plan(lat, lon, zoom, output);
    },

    radarPlan(lat, lon, output = this.outputSize) {
        return this.plan(lat, lon, this.radarZoom, output);
    },
};
