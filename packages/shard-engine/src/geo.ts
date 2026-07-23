/**
 * Pure geospatial helpers backing `.geoIndex()` / `withGeoIndex(...)`.
 *
 * Points are indexed by **geohash** — a base-32 Z-order encoding of a
 * latitude/longitude pair where a shared string prefix implies spatial
 * proximity. A proximity query becomes a set of geohash-prefix range scans (the
 * center cell plus its eight neighbours, at a precision whose cell is at least
 * the query radius, so the 3×3 neighbourhood is guaranteed to cover the circle)
 * followed by an exact Haversine refine on the candidate rows. This module is
 * deliberately dependency-free so it can be unit-tested in isolation and inlined
 * by the bundler.
 */
/* eslint-disable no-secrets/no-secrets -- the base-32 geohash alphabet + Niemeyer adjacency tables are algorithm constants, not credentials */
/* eslint-disable import/exports-last -- each exported helper sits next to its private support code; grouping exports last would scatter the geohash pipeline */

/** The geohash base-32 alphabet (Niemeyer's alphabet). */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Default geohash precision (characters) maintained by a `.geoIndex()` companion — ~4.8 m cells. */
export const GEO_DEFAULT_PRECISION = 9;

/** Mean Earth radius in metres (WGS84 authalic sphere) used by {@link haversineMeters}. */
const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Approximate geohash cell WIDTH in metres by prefix length (index 1..12), at
 * the equator. Used to pick a precision whose cell is at least the query radius
 * so the center-plus-neighbours neighbourhood covers the whole circle. Index 0
 * is a placeholder (a zero-length geohash is the whole globe).
 */
const CELL_WIDTH_METERS = [Number.POSITIVE_INFINITY, 5_009_400, 1_252_300, 156_500, 39_100, 4900, 1200, 152.9, 38.2, 4.77, 1.19, 0.149, 0.037];

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
    const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** The largest geohash precision whose cell width is still at least `radiusMeters`. */
const precisionForRadius = (radiusMeters: number): number => {
    for (let length = CELL_WIDTH_METERS.length - 1; length >= 1; length -= 1) {
        const width = CELL_WIDTH_METERS[length];

        if (width !== undefined && width >= radiusMeters) {
            return length;
        }
    }

    return 1;
};

// Adjacency tables for geohash neighbour computation (Niemeyer's algorithm).
const NEIGHBOURS = {
    east: ["bc01fg45238967deuvhjyznpkmstqrwx", "bc01fg45238967deuvhjyznpkmstqrwx"],
    north: ["p0r21436x8zb9dcf5h7kjnmqesgutwvy", "bc01fg45238967deuvhjyznpkmstqrwx"],
    south: ["14365h7k9dcfesgujnmqp0r2twvyx8zb", "238967debc01fg45kmstqrwxuvhjyznp"],
    west: ["238967debc01fg45kmstqrwxuvhjyznp", "238967debc01fg45kmstqrwxuvhjyznp"],
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
 * at least `radiusMeters` wide — the geohash prefixes to range-scan for a
 * proximity query. Deduplicated (near a pole neighbours can collapse).
 */
export const coveringGeohashes = (center: GeoPoint, radiusMeters: number): string[] => {
    const precision = precisionForRadius(Math.max(radiusMeters, 1));
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
