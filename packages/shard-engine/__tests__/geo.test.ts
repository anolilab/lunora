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
 *
 * The longitude span uses the TRUE `cos(lat)` (not the production
 * {@link MIN_LATITUDE_COSINE} clamp) so that near a pole — where a degree of
 * longitude shrinks to metres and the circle wraps most of the way round — the grid
 * actually samples the full converged longitude range instead of a thin slice; it is
 * capped at a half-circle (`180°`) since beyond that the grid wraps onto itself.
 * Generated coordinates are clamped to `[-90, 90]` latitude and wrapped into
 * `[-180, 180)` longitude so every sampled point is a real WGS84 coordinate even
 * when the sweep reaches over the pole or across the antimeridian.
 */
const uncoveredPointsWithin = (center: { lat: number; lng: number }, radiusMeters: number, steps: number): { lat: number; lng: number }[] => {
    const cover = coveringGeohashes(center, radiusMeters);
    const precision = cover[0]?.length ?? 1;
    const coverSet = new Set(cover);
    const trueCosLat = Math.cos(center.lat * DEG_TO_RAD);
    const latHalfSpanDeg = (radiusMeters * 1.4) / METERS_PER_DEG_LAT;
    const lngHalfSpanDeg = trueCosLat > 0 ? Math.min(180, (radiusMeters * 1.4) / (METERS_PER_DEG_LAT * trueCosLat)) : 180;
    const uncovered: { lat: number; lng: number }[] = [];

    for (let i = -steps; i <= steps; i += 1) {
        for (let j = -steps; j <= steps; j += 1) {
            const rawLat = center.lat + (latHalfSpanDeg * i) / steps;
            const rawLng = center.lng + (lngHalfSpanDeg * j) / steps;
            const point = { lat: Math.max(-90, Math.min(90, rawLat)), lng: ((((rawLng + 180) % 360) + 360) % 360) - 180 };
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

        it("returns the complete pole-cap band near a pole (more than a 3×3, still deduped)", () => {
            expect.assertions(3);

            // Inside the ~0.57° pole caps the covering switches from a 3×3 neighbourhood
            // to a COMPLETE polar band (every longitude sector of each latitude band the
            // circle touches), so the clamped east-west width test can no longer drop an
            // in-radius row. The band therefore returns MORE than 9 cells — the old
            // "≤ 9 cells" relaxation is gone — and is still deduplicated.
            const prefixes = coveringGeohashes({ lat: 89.999, lng: 0 }, 100);

            expect(prefixes.length).toBeGreaterThan(9);
            expect(new Set(prefixes)).toHaveProperty("size", prefixes.length);
            // Every prefix is the same (coarse) length — a single-precision band.
            expect(new Set(prefixes.map((p) => p.length))).toHaveProperty("size", 1);
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

        it("covers every in-radius point for centers near the poleward edge of their cell (Finding 1)", () => {
            // Finding 1: the east-west width bound is evaluated at the circle's POLEWARD
            // extent (`|lat| + radiusDegrees`), not the centre latitude, so a centre
            // sitting near the (narrower) poleward edge of its cell cannot reach past a
            // diagonal neighbour's east-west edge while still inside the radius. Place
            // centres at a spread of sub-cell offsets — including right up against the
            // poleward edge — across mid/high latitudes, both hemispheres, and an
            // antimeridian-adjacent longitude, at gap radii, and assert completeness.
            expect.hasAssertions();

            const GRID_STEPS = 12;
            const baseLats = [45, 60, 75, 85, 88, -60, -82];
            // Fraction of a ~cell-sized degree step, nudging the centre toward the pole;
            // 0.5 lands essentially on the poleward cell edge.
            const edgeOffsets = [0, 0.2, 0.4, 0.48, 0.5];
            const longitudes = [12.3, 179.6];
            const radii = [50, 200, 611, 1000, 5000];

            for (const baseLat of baseLats) {
                for (const offset of edgeOffsets) {
                    for (const lng of longitudes) {
                        for (const radius of radii) {
                            const poleward = baseLat >= 0 ? 1 : -1;
                            const center = { lat: baseLat + poleward * offset * (radius / METERS_PER_DEG_LAT), lng };

                            expect(uncoveredPointsWithin(center, radius, GRID_STEPS)).toStrictEqual([]);
                        }
                    }
                }
            }
        });

        it("covers every in-radius point inside the pole caps via the complete band (Finding 2)", () => {
            // Finding 2: above ~89.43° the MIN_LATITUDE_COSINE clamp overstates east-west
            // cell width, so a 3×3 neighbourhood cannot span the circle and `.near()`
            // would silently drop in-radius rows. The pole-cap fallback returns the
            // COMPLETE covering band instead. Assert zero uncovered in-radius points for
            // centres inside/around both pole caps — including exactly at and "over" the
            // pole, at the antimeridian, and with radii that reach the pole.
            expect.hasAssertions();

            const GRID_STEPS = 18;
            const poleCapLatDeg = Math.acos(MIN_LATITUDE_COSINE) / DEG_TO_RAD; // ~89.43°
            const centers = [
                { lat: 89.5, lng: 0 }, // just inside the north cap
                { lat: 89.9, lng: 179.6 }, // antimeridian-adjacent
                { lat: 89.99, lng: -179.6 },
                { lat: 89.999, lng: 100 },
                { lat: 90, lng: 0 }, // exactly at the north pole
                { lat: -89.6, lng: 0 }, // south cap
                { lat: -89.95, lng: 179.6 },
                { lat: -90, lng: -30 }, // exactly at the south pole
            ];
            // Small radii (well inside the cap) through radii large enough to reach the pole.
            const radii = [50, 200, 1000, 5000, 50_000, 200_000];

            for (const center of centers) {
                // Sanity: every centre is inside (or on the boundary of) a pole cap.
                expect(Math.abs(center.lat)).toBeGreaterThan(poleCapLatDeg - 0.1);

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
