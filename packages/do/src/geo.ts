/**
 * Pure geospatial helpers backing `.geoIndex()` / `withGeoIndex(...)`.
 *
 * Points are indexed by **geohash** — a base-32 Z-order encoding of a
 * latitude/longitude pair where a shared string prefix implies spatial
 * proximity. A proximity query becomes a set of geohash-prefix range scans (the
 * center cell plus its eight neighbours, at a precision chosen so the cell meets
 * two independent physical constraints — its north-south height and its
 * latitude-adjusted east-west width are each at least the query radius — so the
 * 3×3 neighbourhood covers the circle) followed by an exact Haversine refine on
 * the candidate rows. This covering is complete except within the ~0.57° pole caps
 * (|lat| > ~89.43°), where the {@link MIN_LATITUDE_COSINE} clamp can leave the 3×3
 * short of the circle east-west (a near-pole `.near()` may drop in-radius rows);
 * see that constant for the bounded, pre-existing gap and the pole-cap fix it
 * awaits. This module is deliberately dependency-free so it can be unit-tested in
 * isolation and inlined by the bundler.
 */
/* eslint-disable no-secrets/no-secrets -- the base-32 geohash alphabet + Niemeyer adjacency tables are algorithm constants, not credentials */
/* eslint-disable import/exports-last -- each exported helper sits next to its private support code; grouping exports last would scatter the geohash pipeline */

/** The geohash base-32 alphabet (Niemeyer's alphabet). */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Default geohash precision (characters) maintained by a `.geoIndex()` companion — ~4.8 m cells. */
export const GEO_DEFAULT_PRECISION = 9;

/** Mean Earth radius in metres (WGS84 authalic sphere) used by {@link haversineMeters}. */
const EARTH_RADIUS_METERS = 6_371_008.8;

/** Degrees → radians factor, shared by {@link haversineMeters} and {@link precisionForRadius}. */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Approximate geohash cell WIDTH (east-west extent) in metres by prefix length
 * (index 1..12), at the equator. Index 0 is a placeholder (a zero-length geohash
 * is the whole globe). Cells are square at odd lengths and twice as wide as they
 * are tall at even lengths (each geohash char adds 3 lng + 2 lat bits, alternating
 * with a leading lng bit), so this is *not* the covering basis on its own — see
 * {@link CELL_HEIGHT_METERS}.
 */
const CELL_WIDTH_METERS = [Number.POSITIVE_INFINITY, 5_009_400, 1_252_300, 156_500, 39_100, 4900, 1200, 152.9, 38.2, 4.77, 1.19, 0.149, 0.037];

/**
 * Approximate geohash cell HEIGHT (north-south extent) in metres by prefix length.
 * Unlike width, height does NOT converge toward the poles, so it is latitude-
 * independent. Derived from {@link CELL_WIDTH_METERS}: even prefix lengths yield
 * cells half as tall as wide (`width / 2`); odd lengths yield (approximately)
 * square cells (`width`). Height is one of the two independent constraints
 * {@link precisionForRadius} requires the covering cell to satisfy — paired with
 * the latitude-adjusted width, it replaces the old single "min dimension" basis.
 */
const CELL_HEIGHT_METERS = CELL_WIDTH_METERS.map((width, length) => (length % 2 === 0 ? width / 2 : width));

/**
 * Latitude cosine floor applied to the east-west width test for longitude
 * convergence. A cell's east-west metre width scales by `cos(lat)`, so the covering
 * requires `width · cos(lat) ≥ radius`; this clamp keeps the multiplier positive
 * near the poles (picking a coarser precision) rather than collapsing it to zero.
 *
 * NOTE — the covering is therefore NOT literally complete for |lat| > ~89.43°
 * (where `cos(lat) < 0.01`): past that latitude the clamped width test overstates
 * the true east-west reach, so the 3×3 neighbourhood can fall short of the circle
 * and a near-pole `.near()` may silently drop in-radius rows. The gap is bounded
 * (only the ~0.57° pole caps) and pre-existing; the proper fix is a pole-cap
 * special case that scans the whole cap instead of a 3×3 — deliberately out of
 * scope here.
 */
const MIN_LATITUDE_COSINE = 0.01;

/** A latitude/longitude point (WGS84 decimal degrees). */
export interface GeoPoint {
    lat: number;
    lng: number;
}

/** An axis-aligned latitude/longitude bounding box (`sw`/`ne` corners). */
export interface GeoBoundingBox {
    ne: GeoPoint;
    sw: GeoPoint;
}

/** Clamp `precision` into the supported 1..12 geohash-length range. */
const clampPrecision = (precision: number): number => Math.min(Math.max(Math.trunc(precision), 1), 12);

/**
 * Encode `point` to a geohash of `precision` characters. Standard interleaved
 * lat/lng bisection over the base-32 alphabet.
 */
export const encodeGeohash = (point: GeoPoint, precision: number): string => {
    const chars = clampPrecision(precision);
    let latMin = -90;
    let latMax = 90;
    let lngMin = -180;
    let lngMax = 180;
    let hash = "";
    let bit = 0;
    let index = 0;
    let even = true;

    while (hash.length < chars) {
        if (even) {
            const mid = (lngMin + lngMax) / 2;

            if (point.lng >= mid) {
                index = index * 2 + 1;
                lngMin = mid;
            } else {
                index *= 2;
                lngMax = mid;
            }
        } else {
            const mid = (latMin + latMax) / 2;

            if (point.lat >= mid) {
                index = index * 2 + 1;
                latMin = mid;
            } else {
                index *= 2;
                latMax = mid;
            }
        }

        even = !even;

        if (bit < 4) {
            bit += 1;
        } else {
            hash += BASE32[index] ?? "0";
            bit = 0;
            index = 0;
        }
    }

    return hash;
};

/** Great-circle distance between two points in metres (Haversine). */
export const haversineMeters = (a: GeoPoint, b: GeoPoint): number => {
    const dLat = (b.lat - a.lat) * DEG_TO_RAD;
    const dLng = (b.lng - a.lng) * DEG_TO_RAD;
    const lat1 = a.lat * DEG_TO_RAD;
    const lat2 = b.lat * DEG_TO_RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * The largest (finest) geohash precision whose cell satisfies both covering
 * constraints at `lat`: its north-south {@link CELL_HEIGHT_METERS height} and its
 * latitude-adjusted east-west width (`{@link CELL_WIDTH_METERS width} · cos(lat)`,
 * with `cos(lat)` clamped by {@link MIN_LATITUDE_COSINE}) are each at least
 * `radiusMeters`. Treating the two axes independently — rather than discounting a
 * single "min dimension" by `1 / cos(lat)`, which over-coarsened the height axis at
 * mid latitudes — picks an equal-or-finer precision while still only ever
 * over-covering the circle.
 */
const precisionForRadius = (radiusMeters: number, lat: number): number => {
    const cosLat = Math.max(Math.cos(lat * DEG_TO_RAD), MIN_LATITUDE_COSINE);

    for (let length = CELL_WIDTH_METERS.length - 1; length >= 1; length -= 1) {
        const width = CELL_WIDTH_METERS[length];
        const height = CELL_HEIGHT_METERS[length];

        if (width !== undefined && height !== undefined && width * cosLat >= radiusMeters && height >= radiusMeters) {
            return length;
        }
    }

    return 1;
};

// Adjacency tables for geohash neighbour computation (Niemeyer's algorithm).
// Each entry is [even-length row, odd-length row]. The odd-length east/west rows
// are DELIBERATELY the even-length north/south rows (a real geohash-js property:
// axes swap between even and odd lengths) — do NOT "re-align" them to match the
// even east/west rows. They were previously (incorrectly) duplicated from the even
// east/west rows, which made `adjacent(..., "east"|"west")` move north/south at odd
// lengths and silently dropped E/W proximity candidates (fixed).
const NEIGHBOURS = {
    east: ["bc01fg45238967deuvhjyznpkmstqrwx", "p0r21436x8zb9dcf5h7kjnmqesgutwvy"],
    north: ["p0r21436x8zb9dcf5h7kjnmqesgutwvy", "bc01fg45238967deuvhjyznpkmstqrwx"],
    south: ["14365h7k9dcfesgujnmqp0r2twvyx8zb", "238967debc01fg45kmstqrwxuvhjyznp"],
    west: ["238967debc01fg45kmstqrwxuvhjyznp", "14365h7k9dcfesgujnmqp0r2twvyx8zb"],
} as const;
const BORDERS = {
    east: ["bcfguvyz", "prxz"],
    north: ["prxz", "bcfguvyz"],
    south: ["028b", "0145hjnp"],
    west: ["0145hjnp", "028b"],
} as const;

type Direction = keyof typeof NEIGHBOURS;

/** The geohash of the cell adjacent to `hash` in `direction` (same precision). */
const adjacent = (hash: string, direction: Direction): string => {
    const lower = hash.toLowerCase();
    const lastChar = lower.at(-1) ?? "";
    let base = lower.slice(0, -1);
    const type: 0 | 1 = lower.length % 2 === 0 ? 0 : 1; // 0 = even length, 1 = odd

    if (BORDERS[direction][type].includes(lastChar) && base !== "") {
        base = adjacent(base, direction);
    }

    return base + (BASE32[NEIGHBOURS[direction][type].indexOf(lastChar)] ?? "");
};

/**
 * The center cell plus its eight neighbours at a precision chosen so each cell is
 * at least `radiusMeters` in both its north-south height and its latitude-adjusted
 * east-west width, so the 3×3 neighbourhood covers the circle (except within the
 * ~0.57° pole caps — see {@link MIN_LATITUDE_COSINE}). These are the geohash
 * prefixes to range-scan for a proximity query. Deduplicated (near a pole
 * neighbours can collapse).
 */
export const coveringGeohashes = (center: GeoPoint, radiusMeters: number): string[] => {
    const precision = precisionForRadius(Math.max(radiusMeters, 1), center.lat);
    const origin = encodeGeohash(center, precision);
    const north = adjacent(origin, "north");
    const south = adjacent(origin, "south");
    const cells = [
        origin,
        north,
        south,
        adjacent(origin, "east"),
        adjacent(origin, "west"),
        adjacent(north, "east"),
        adjacent(north, "west"),
        adjacent(south, "east"),
        adjacent(south, "west"),
    ];

    return [...new Set(cells)];
};

/** Whether `point` falls inside `box` (inclusive edges). */
export const pointInBoundingBox = (point: GeoPoint, box: GeoBoundingBox): boolean =>
    point.lat >= box.sw.lat && point.lat <= box.ne.lat && point.lng >= box.sw.lng && point.lng <= box.ne.lng;

/** The center of a bounding box. */
export const boundingBoxCenter = (box: GeoBoundingBox): GeoPoint => {
    return { lat: (box.sw.lat + box.ne.lat) / 2, lng: (box.sw.lng + box.ne.lng) / 2 };
};

/**
 * Geohash prefixes covering `box`: the covering cells of the circle centered on
 * the box whose radius reaches the north-east corner, guaranteeing every point
 * in the box is scanned before the exact `pointInBoundingBox` refine.
 */
export const boundingBoxGeohashes = (box: GeoBoundingBox): string[] => {
    const center = boundingBoxCenter(box);

    return coveringGeohashes(center, Math.max(haversineMeters(center, box.ne), 1));
};
