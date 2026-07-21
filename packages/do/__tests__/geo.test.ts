import { describe, expect, it } from "vitest";

import { boundingBoxGeohashes, coveringGeohashes, encodeGeohash, haversineMeters, pointInBoundingBox } from "../src/geo";

/** Pure geohash / distance helpers backing `.geoIndex()`. */
describe("geo helpers", () => {
    it("encodes a known geohash", () => {
        expect.assertions(2);

        // The canonical geohash of (57.64911, 10.40744) is "u4pruydqqvj".
        expect(encodeGeohash({ lat: 57.649_11, lng: 10.407_44 }, 11)).toBe("u4pruydqqvj");
        // A shorter precision is the prefix of a longer one at the same point.
        expect(encodeGeohash({ lat: 57.649_11, lng: 10.407_44 }, 5)).toBe("u4pru");
    });

    it("computes Haversine distance within tolerance", () => {
        expect.assertions(2);

        // Times Square → Brooklyn is ~9 km.
        const meters = haversineMeters({ lat: 40.758, lng: -73.9855 }, { lat: 40.6782, lng: -73.9442 });

        expect(meters).toBeGreaterThan(8000);
        expect(meters).toBeLessThan(10_500);
    });

    it("returns the center cell plus its neighbours as covering prefixes", () => {
        expect.assertions(2);

        const prefixes = coveringGeohashes({ lat: 40.758, lng: -73.9855 }, 1000);

        // The center cell is always included, and there are up to 9 unique cells.
        expect(prefixes).toContain(encodeGeohash({ lat: 40.758, lng: -73.9855 }, prefixes[0]?.length ?? 1));
        expect(prefixes.length).toBeLessThanOrEqual(9);
    });

    it("tests bounding-box membership inclusively", () => {
        expect.assertions(3);

        const box = { ne: { lat: 41, lng: -73 }, sw: { lat: 40, lng: -74 } };

        expect(pointInBoundingBox({ lat: 40.5, lng: -73.5 }, box)).toBe(true);
        expect(pointInBoundingBox({ lat: 40, lng: -74 }, box)).toBe(true); // corner
        expect(pointInBoundingBox({ lat: 39.9, lng: -73.5 }, box)).toBe(false);
    });

    it("produces covering prefixes for a bounding box", () => {
        expect.assertions(1);

        const prefixes = boundingBoxGeohashes({ ne: { lat: 40.9, lng: -73.7 }, sw: { lat: 40.5, lng: -74.3 } });

        expect(prefixes.length).toBeGreaterThan(0);
    });
});
