import { describe, expect, it } from "vitest";

import {
    boundingBoxCenter,
    boundingBoxGeohashes,
    coveringGeohashes,
    encodeGeohash,
    GEO_DEFAULT_PRECISION,
    haversineMeters,
    pointInBoundingBox,
} from "../src/geo";

/** Every char a geohash may contain (base-32, Niemeyer alphabet — no a/i/l/o). */
const BASE32_ONLY = /^[0-9b-hjkmnp-z]+$/u;

const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_320;
/** Mirrors production `MIN_LATITUDE_COSINE` in ../src/geo — keep the two in sync. */
const MIN_LATITUDE_COSINE = 0.01;

/**
 * In-radius grid points that {@link coveringGeohashes} fails to cover — i.e. false
 * negatives. Sweeps a deterministic `(2·steps+1)²` lat/lng grid out to 1.4× the
 * radius around `center` (both inside and outside the circle) and returns every
 * point within `radius` whose geohash (at the covering precision) is absent from
 * the covering set. An empty result means the covering set is complete.
 */
const uncoveredPointsWithin = (center: { lat: number; lng: number }, radiusMeters: number, steps: number): { lat: number; lng: number }[] => {
    const cover = coveringGeohashes(center, radiusMeters);
    const precision = cover[0]?.length ?? 1;
    const coverSet = new Set(cover);
    const cosLat = Math.max(Math.cos(center.lat * DEG_TO_RAD), MIN_LATITUDE_COSINE);
    const latHalfSpanDeg = (radiusMeters * 1.4) / METERS_PER_DEG_LAT;
    const lngHalfSpanDeg = (radiusMeters * 1.4) / (METERS_PER_DEG_LAT * cosLat);
    const uncovered: { lat: number; lng: number }[] = [];

    for (let i = -steps; i <= steps; i += 1) {
        for (let j = -steps; j <= steps; j += 1) {
            const point = { lat: center.lat + (latHalfSpanDeg * i) / steps, lng: center.lng + (lngHalfSpanDeg * j) / steps };
            const inRadius = haversineMeters(center, point) <= radiusMeters;

            if (inRadius && !coverSet.has(encodeGeohash(point, precision))) {
                uncovered.push(point);
            }
        }
    }

    return uncovered;
};

/** Pure geohash / distance helpers backing `.geoIndex()`. */
describe("geo helpers", () => {
    describe("encodeGeohash", () => {
        it("encodes a known geohash and its shorter prefix", () => {
            expect.assertions(2);

            // The canonical geohash of (57.64911, 10.40744) is "u4pruydqqvj".
            expect(encodeGeohash({ lat: 57.649_11, lng: 10.407_44 }, 11)).toBe("u4pruydqqvj");
            // A shorter precision is the prefix of a longer one at the same point.
            expect(encodeGeohash({ lat: 57.649_11, lng: 10.407_44 }, 5)).toBe("u4pru");
        });

        it("encodes the origin (0, 0) at the alphabet boundary", () => {
            expect.assertions(1);

            // (0,0) sits on the prime-meridian/equator corner — canonical hash "s0000...".
            expect(encodeGeohash({ lat: 0, lng: 0 }, 6)).toBe("s00000");
        });

        it("clamps precision below 1 up to a single character", () => {
            expect.assertions(2);

            expect(encodeGeohash({ lat: 40.758, lng: -73.9855 }, 0)).toHaveLength(1);
            expect(encodeGeohash({ lat: 40.758, lng: -73.9855 }, -5)).toHaveLength(1);
        });

        it("clamps precision above 12 down to twelve characters", () => {
            expect.assertions(1);

            expect(encodeGeohash({ lat: 40.758, lng: -73.9855 }, 99)).toHaveLength(12);
        });

        it("produces valid base-32 hashes at the poles and the antimeridian", () => {
            expect.assertions(4);

            for (const point of [
                { lat: 90, lng: 0 }, // north pole
                { lat: -90, lng: 0 }, // south pole
                { lat: 0, lng: 180 }, // antimeridian east
                { lat: 0, lng: -180 }, // antimeridian west
            ]) {
                expect(encodeGeohash(point, 9)).toMatch(BASE32_ONLY);
            }
        });
    });

    describe("haversineMeters", () => {
        it("computes a known distance within tolerance", () => {
            expect.assertions(2);

            // Times Square → Brooklyn is ~9 km.
            const meters = haversineMeters({ lat: 40.758, lng: -73.9855 }, { lat: 40.6782, lng: -73.9442 });

            expect(meters).toBeGreaterThan(8000);
            expect(meters).toBeLessThan(10_500);
        });

        it("is zero for identical points", () => {
            expect.assertions(1);

            expect(haversineMeters({ lat: 40.758, lng: -73.9855 }, { lat: 40.758, lng: -73.9855 })).toBe(0);
        });

        it("is symmetric", () => {
            expect.assertions(1);

            const nyc = { lat: 40.758, lng: -73.9855 };
            const la = { lat: 34.0522, lng: -118.2437 };

            expect(haversineMeters(nyc, la)).toBeCloseTo(haversineMeters(la, nyc), 6);
        });

        it("returns ~half the Earth's circumference for antipodal points (clamp holds)", () => {
            expect.assertions(2);

            // (0,0) → (0,180) is exactly half a great circle ≈ 20,015 km; the
            // `Math.min(1, sqrt(h))` clamp keeps `asin` in range at the antipode.
            const meters = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });

            expect(meters).toBeGreaterThan(20_000_000);
            expect(meters).toBeLessThan(20_040_000);
        });
    });

    describe("coveringGeohashes", () => {
        it("always contains the center cell and returns only unique prefixes", () => {
            expect.assertions(2);

            const center = { lat: 40.758, lng: -73.9855 };
            const prefixes = coveringGeohashes(center, 1000);

            expect(prefixes).toContain(encodeGeohash(center, prefixes[0]?.length ?? 1));
            // The `new Set(...)` dedup guarantee: no cell appears twice.
            expect(new Set(prefixes)).toHaveProperty("size", prefixes.length);
        });

        it("realizes the full 3×3 neighbourhood at mid-latitude", () => {
            expect.assertions(1);

            expect(coveringGeohashes({ lat: 40.758, lng: -73.9855 }, 200)).toHaveLength(9);
        });

        it("picks a finer precision (longer prefixes) for a smaller radius", () => {
            expect.assertions(1);

            const center = { lat: 40.758, lng: -73.9855 };
            const tight = coveringGeohashes(center, 100);
            const wide = coveringGeohashes(center, 100_000);

            expect(tight[0]?.length ?? 0).toBeGreaterThan(wide[0]?.length ?? 0);
        });

        it("returns a valid deduped covering set near a pole", () => {
            expect.assertions(2);

            // Precision selection is now latitude-aware: near the pole the query radius
            // is inflated by 1/cos(lat) (clamped), so a much coarser precision is chosen
            // than the old width-only logic picked. The covering set is still a valid,
            // deduplicated 3×3-or-collapsed neighbourhood (≤ 9 cells, never empty) — the
            // exact cell count is no longer pinned because it depends on the (now coarser)
            // latitude-adjusted precision.
            const prefixes = coveringGeohashes({ lat: 89.999, lng: 0 }, 100);

            expect(prefixes.length).toBeGreaterThan(0);
            expect(prefixes.length).toBeLessThanOrEqual(9);
        });

        it("covers every point within the radius across latitudes and precision-gap radii", () => {
            // Completeness property: the 3×3 covering set is the ONLY candidate filter
            // before the exact Haversine refine, so every point within `radius` of the
            // center must hash (at the covering precision) into the covering set — else
            // it is a silent false negative. Deterministic fixed grid (no Math.random):
            // centers incl. high latitude, radii landing just above each N-S cell-height
            // (min-dimension) threshold where the old width-only covering under-reached —
            // notably just past the ~600 m len-6 height (611/700/1000/1200) and the
            // ~19.1 m len-8 height (30/38/50) — and a dense lat/lng grid of candidate
            // points around each center.
            expect.hasAssertions();

            const GRID_STEPS = 14; // points per axis, each side of center
            const centers = [
                { lat: 0, lng: 0 }, // equator
                { lat: 40.758, lng: -73.9855 }, // mid-latitude (NYC)
                { lat: 60, lng: 10 }, // high latitude
                { lat: 70, lng: -100 }, // higher latitude — strong longitude convergence
            ];
            // Radii chosen at and inside the precision-gap intervals where the old
            // width-only covering silently dropped candidates.
            const radii = [30, 38, 50, 100, 200, 611, 700, 1000, 1200, 5000, 10_000, 39_000];

            for (const center of centers) {
                for (const radius of radii) {
                    expect(uncoveredPointsWithin(center, radius, GRID_STEPS)).toStrictEqual([]);
                }
            }
        });
    });

    describe("pointInBoundingBox", () => {
        it("includes the interior and both corners, excludes each axis", () => {
            expect.assertions(5);

            const box = { ne: { lat: 41, lng: -73 }, sw: { lat: 40, lng: -74 } };

            expect(pointInBoundingBox({ lat: 40.5, lng: -73.5 }, box)).toBe(true); // interior
            expect(pointInBoundingBox({ lat: 40, lng: -74 }, box)).toBe(true); // sw corner
            expect(pointInBoundingBox({ lat: 41, lng: -73 }, box)).toBe(true); // ne corner
            expect(pointInBoundingBox({ lat: 39.9, lng: -73.5 }, box)).toBe(false); // south of box
            expect(pointInBoundingBox({ lat: 40.5, lng: -72.9 }, box)).toBe(false); // east of box
        });
    });

    describe("boundingBoxCenter", () => {
        it("returns the midpoint of the corners", () => {
            expect.assertions(1);

            expect(boundingBoxCenter({ ne: { lat: 41, lng: -73 }, sw: { lat: 40, lng: -75 } })).toStrictEqual({ lat: 40.5, lng: -74 });
        });
    });

    describe("boundingBoxGeohashes", () => {
        it("covers the box — its center cell is among the prefixes", () => {
            expect.assertions(2);

            const box = { ne: { lat: 40.9, lng: -73.7 }, sw: { lat: 40.5, lng: -74.3 } };
            const prefixes = boundingBoxGeohashes(box);

            expect(prefixes.length).toBeGreaterThan(0);
            expect(prefixes).toContain(encodeGeohash(boundingBoxCenter(box), prefixes[0]?.length ?? 1));
        });
    });

    it("defaults the companion precision to 9 (~4.8 m cells)", () => {
        expect.assertions(1);

        expect(GEO_DEFAULT_PRECISION).toBe(9);
    });
});
