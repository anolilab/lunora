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
 * the candidate rows. Both physical constraints are evaluated at the query
 * circle's POLEWARD extent (`|lat| + radius-as-degrees`), not the centre latitude,
 * so that a centre sitting near the poleward edge of its cell cannot reach past a
 * (narrower) poleward neighbour — see {@link precisionForRadius}. Inside the
 * ~0.57° pole caps (|lat| > ~89.43°), where the {@link MIN_LATITUDE_COSINE} clamp
 * would otherwise leave the 3×3 short of the circle east-west, the covering falls
 * back to a complete polar band (every longitude sector of every latitude band the
 * circle touches — see {@link coveringGeohashes}) so no in-radius row is ever
 * dropped. This module is deliberately dependency-free so it can be unit-tested in
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
 * Because the clamp overstates the true east-west reach for |lat| > ~89.43° (where
 * `cos(lat) < 0.01`), a 3×3 neighbourhood there can fall short of the circle
 * east-west. {@link coveringGeohashes} detects exactly that zone — the query
 * circle's poleward extent reaching the clamp latitude {@link LAT_CAP_DEGREES} — and
 * substitutes a complete polar band, so the clamp never causes a dropped in-radius
 * row; it only ever picks a (safe) coarser precision away from the caps.
 */
const MIN_LATITUDE_COSINE = 0.01;

/**
 * The latitude at which {@link MIN_LATITUDE_COSINE} starts to bind
 * (`acos(0.01) ≈ 89.43°`). Once the query circle's poleward extent reaches this
 * latitude the clamped east-west width test can no longer be trusted, so
 * {@link coveringGeohashes} switches to the {@link poleCapCovering} polar band.
 */
const LAT_CAP_DEGREES = Math.acos(MIN_LATITUDE_COSINE) / DEG_TO_RAD;

/**
 * Precision cap for the polar-band fallback. The band enumerates EVERY longitude
 * sector of each latitude band the circle touches, and a geohash of length `k` has
 * `2^ceil(5k/2)` longitude sectors — 8 (k=1), 32 (k=2), 256 (k=3)… — so the cap
 * bounds how many prefixes the band can emit. At `2` the worst case over all
 * legitimate near-pole queries is 32 prefixes (`bandCount(2)` × 1 band, or 8 × 4
 * bands at k=1 for a hemisphere-spanning radius). The band is correct at ANY
 * precision (all longitudes + every touched latitude band ⇒ complete), so capping
 * only trades a slightly coarser scan for a bounded prefix count.
 */
const POLE_CAP_MAX_PRECISION = 2;

/** The query radius expressed as degrees of latitude (arc length on the sphere). */
const radiusDegrees = (radiusMeters: number): number => radiusMeters / EARTH_RADIUS_METERS / DEG_TO_RAD;

/**
 * The number of longitude sectors and latitude bands a geohash grid of `length`
 * characters divides the globe into. Each character adds 5 bits (lng first, then
 * alternating), so `5·length` bits split as `ceil` lng / `floor` lat.
 */
const geohashBandCounts = (length: number): { latBands: number; lngSectors: number } => {
    const totalBits = 5 * length;

    return { latBands: 2 ** Math.floor(totalBits / 2), lngSectors: 2 ** Math.ceil(totalBits / 2) };
};

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

/** The circle's poleward latitude extent `φ = min(90, |lat| + radiusDegrees)` — the φ both covering tests evaluate at. */
const polewardLatitude = (lat: number, radiusMeters: number): number => Math.min(90, Math.abs(lat) + radiusDegrees(radiusMeters));

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
 * latitude-adjusted east-west width (`{@link CELL_WIDTH_METERS width} · cos(φ)`,
 * with `cos(φ)` clamped by {@link MIN_LATITUDE_COSINE}) are each at least
 * `radiusMeters`. Treating the two axes independently — rather than discounting a
 * single "min dimension" by `1 / cos(lat)`, which over-coarsened the height axis at
 * mid latitudes — picks an equal-or-finer precision while still only ever
 * over-covering the circle.
 *
 * The width is evaluated at the circle's POLEWARD extent
 * `φ = min(90, |lat| + radiusDegrees)`, not the centre latitude. At `lat` the
 * circle reaches to `lat ± radiusDegrees`, and the poleward neighbour cell is
 * narrower on its poleward side; a centre near that boundary can otherwise reach
 * past the diagonal neighbour's east-west edge while still `width · cos(lat) ≥
 * radius`. Using `cos(φ) ≤ cos(lat)` only ever picks an equal-or-coarser precision
 * (a wider candidate set) — it never narrows the covering.
 */
const precisionForRadius = (radiusMeters: number, lat: number): number => {
    const cosLat = Math.max(Math.cos(polewardLatitude(lat, radiusMeters) * DEG_TO_RAD), MIN_LATITUDE_COSINE);

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
 * A COMPLETE polar-band covering: every longitude sector of every latitude band the
 * query circle touches, at `min(precision, {@link POLE_CAP_MAX_PRECISION})`. Used
 * only inside the pole caps, where longitude convergence lets the circle wrap past a
 * 3×3 neighbourhood east-west. Because it enumerates ALL longitudes for the touched
 * latitude bands, and every in-radius point lies within `radiusDegrees` of the
 * centre latitude (great-circle arc ≥ latitude delta), the band is exhaustive — no
 * in-radius row can hash outside it. Cell count is bounded by the precision cap (≤ 32
 * prefixes over all legitimate near-pole queries).
 */
const poleCapCovering = (center: GeoPoint, radiusMeters: number, precision: number): string[] => {
    const bandPrecision = Math.min(precision, POLE_CAP_MAX_PRECISION);
    const { latBands, lngSectors } = geohashBandCounts(bandPrecision);
    const bandHeight = 180 / latBands;
    const lngWidth = 360 / lngSectors;
    const radiusDeg = radiusDegrees(radiusMeters);
    const lo = Math.max(-90, center.lat - radiusDeg);
    const hi = Math.min(90, center.lat + radiusDeg);
    const cells = new Set<string>();

    for (let band = 0; band < latBands; band += 1) {
        const bandLo = -90 + band * bandHeight;
        const bandHi = bandLo + bandHeight;

        // Skip latitude bands the circle's latitude span [lo, hi] does not touch.
        if (bandHi < lo || bandLo > hi) {
            continue;
        }

        const bandCenterLat = bandLo + bandHeight / 2;

        for (let sector = 0; sector < lngSectors; sector += 1) {
            const sectorCenterLng = -180 + (sector + 0.5) * lngWidth;

            cells.add(encodeGeohash({ lat: bandCenterLat, lng: sectorCenterLng }, bandPrecision));
        }
    }

    return [...cells];
};

/**
 * The center cell plus its eight neighbours at a precision chosen so each cell is
 * at least `radiusMeters` in both its north-south height and its latitude-adjusted
 * east-west width, so the 3×3 neighbourhood covers the circle. When the query
 * circle's poleward extent reaches the {@link LAT_CAP_DEGREES pole-cap latitude} —
 * where the {@link MIN_LATITUDE_COSINE} clamp would let the circle out-reach the 3×3
 * east-west — the result is instead a complete {@link poleCapCovering polar band}.
 * These are the geohash prefixes to range-scan for a proximity query. Deduplicated
 * (near a pole neighbours can collapse).
 */
export const coveringGeohashes = (center: GeoPoint, radiusMeters: number): string[] => {
    const radius = Math.max(radiusMeters, 1);
    const precision = precisionForRadius(radius, center.lat);
    const latPoleward = polewardLatitude(center.lat, radius);

    // Once the circle's poleward extent reaches the cap latitude the clamped
    // east-west width test is unsafe for a 3×3 (this is exactly where cos(φ) would
    // fall below MIN_LATITUDE_COSINE), so return a complete polar band instead.
    if (latPoleward >= LAT_CAP_DEGREES) {
        return poleCapCovering(center, radius, precision);
    }

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
