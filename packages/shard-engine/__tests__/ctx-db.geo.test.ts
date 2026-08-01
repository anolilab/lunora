import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Behavioral coverage of `.withGeoIndex().near()/.within()` against a real SQLite
 * engine (`node:sqlite`). Exercises the geohash-companion range scan + Haversine
 * refine end to end: nearest-first ordering, radius filtering, bounding-box
 * membership, and companion re-sync on patch.
 */

const geoSchema: SchemaLike = {
    tables: {
        places: {
            geoIndexes: [{ field: "location", name: "by_location" }],
            indexes: [],
            shape: {
                location: { kind: "geoPoint" },
                name: { kind: "string" },
            },
        },
    },
};

// A cluster of real coordinates: Times Square, Brooklyn (~8 km), Newark (~15 km),
// and Los Angeles (~3900 km) as the far outlier.
const TIMES_SQUARE = { lat: 40.758, lng: -73.9855 };
const BROOKLYN = { lat: 40.6782, lng: -73.9442 };
const NEWARK = { lat: 40.7357, lng: -74.1724 };
const LOS_ANGELES = { lat: 34.0522, lng: -118.2437 };

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (schema: SchemaLike = geoSchema): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    let now = 1_700_000_000_000;
    let counter = 0;

    const clock = (): number => {
        now += 1;

        return now;
    };

    const idGenerator = (): string => {
        counter += 1;

        return `p${String(counter)}`;
    };

    return createShardContextDatabase({ clock, idGenerator, schema, sql: harness.sql });
};

// A geo table that also declares `.softDelete()` — exercises the companion
// removal on soft delete and its re-add on restore.
const softGeoSchema: SchemaLike = {
    tables: {
        spots: {
            geoIndexes: [{ field: "location", name: "by_location" }],
            indexes: [],
            shape: {
                deletedAt: { kind: "number" },
                location: { kind: "geoPoint" },
                name: { kind: "string" },
            },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

describe("ctx-db geo", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("returns points within a radius ordered nearest-first", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });
        await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });
        await writer.insert("places", { location: NEWARK, name: "newark" });
        await writer.insert("places", { location: LOS_ANGELES, name: "la" });

        const results = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 20_000))
            .collect();

        // LA is ~3900 km away (excluded); the rest come back nearest-first.
        expect(results.map((document) => document["name"])).toStrictEqual(["times-square", "brooklyn", "newark"]);
    });

    it("excludes points beyond the radius", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });
        await writer.insert("places", { location: LOS_ANGELES, name: "la" });

        // A 1 km radius around Times Square keeps only Times Square itself.
        const results = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 1000))
            .collect();

        expect(results.map((document) => document["name"])).toStrictEqual(["times-square"]);
    });

    it("returns points inside a bounding box", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });
        await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });
        await writer.insert("places", { location: LOS_ANGELES, name: "la" });

        // A box spanning the NYC metro area; LA falls well outside it.
        const results = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.within({ ne: { lat: 40.9, lng: -73.7 }, sw: { lat: 40.5, lng: -74.3 } }))
            .collect();

        expect(results.map((document) => document["name"]).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual(["brooklyn", "times-square"]);
    });

    it("re-syncs the companion when a point is patched", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        const id = await writer.insert("places", { location: LOS_ANGELES, name: "mover" });

        // Not near Times Square yet.
        const before = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 5000))
            .collect();

        expect(before).toStrictEqual([]);

        // Move it into range; the geohash companion must update.
        await writer.patch(id, { location: TIMES_SQUARE });

        const after = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 5000))
            .collect();

        expect(after.map((document) => document["name"])).toStrictEqual(["mover"]);
    });

    it("caps results with .take(n) in nearest-first order", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });
        await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });
        await writer.insert("places", { location: NEWARK, name: "newark" });

        const results = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 30_000))
            .take(2);

        expect(results.map((document) => document["name"])).toStrictEqual(["times-square", "brooklyn"]);
    });

    it("drops a point from geo results when it is hard-deleted", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        const id = await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });
        await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });

        const before = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 20_000))
            .collect();

        expect(before.map((document) => document["name"])).toStrictEqual(["times-square", "brooklyn"]);

        // Deleting removes the geohash companion row (syncGeo(..., undefined)).
        await writer.delete(id);

        const after = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 20_000))
            .collect();

        expect(after.map((document) => document["name"])).toStrictEqual(["brooklyn"]);
    });

    it("re-syncs the companion when a point is replaced", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        const id = await writer.insert("places", { location: LOS_ANGELES, name: "mover" });

        const before = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 5000))
            .collect();

        expect(before).toStrictEqual([]);

        // A full replace (not a patch) must also re-sync the companion.
        await writer.replace(id, { location: TIMES_SQUARE, name: "mover" });

        const after = await writer
            .query("places")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 5000))
            .collect();

        expect(after.map((document) => document["name"])).toStrictEqual(["mover"]);
    });

    it("hides a soft-deleted point and re-adds it on restore", async () => {
        expect.assertions(3);

        const writer = setupWriter(softGeoSchema);

        const id = await writer.insert("spots", { location: TIMES_SQUARE, name: "cafe" });

        const initial = await writer
            .query("spots")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 5000))
            .collect();

        expect(initial.map((document) => document["name"])).toStrictEqual(["cafe"]);

        // Soft delete removes the companion row so the point drops out of geo reads.
        await writer.delete(id);

        const deleted = await writer
            .query("spots")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 5000))
            .collect();

        expect(deleted).toStrictEqual([]);

        // Restore clears the marker via patch, which re-adds the companion row.
        await writer.restore?.(id);

        const restored = await writer
            .query("spots")
            .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 5000))
            .collect();

        expect(restored.map((document) => document["name"])).toStrictEqual(["cafe"]);
    });

    describe("collectWithScores", () => {
        it("pairs each .near() result with its distance, nearest-first", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });
            await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });
            await writer.insert("places", { location: NEWARK, name: "newark" });

            const results = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 20_000))
                .collectWithScores();

            expect(results.map((entry) => entry.document["name"])).toStrictEqual(["times-square", "brooklyn", "newark"]);
            // Times Square is (approximately) the query point, so it comes back
            // very close to 0 meters and strictly nearer than Brooklyn.
            expect(results[0]?.distanceMeters).toBeLessThan(1000);
            expect(results[0]?.distanceMeters).toBeLessThan(results[1]?.distanceMeters ?? 0);
        });

        it("surfaces null distanceMeters for .within() box matches", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });
            await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });

            const results = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.within({ ne: { lat: 40.9, lng: -73.7 }, sw: { lat: 40.5, lng: -74.3 } }))
                .collectWithScores();

            expect(results).toHaveLength(2);
            // A box match has no point-distance metric — null documents "not
            // applicable" rather than the misleading "exactly here" of a 0.
            expect(results.every((entry) => entry.distanceMeters === null)).toBe(true);
        });

        it("returns the same documents .collect() would, unchanged", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });
            await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });

            const bare = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 20_000))
                .collect();
            const scored = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 20_000))
                .collectWithScores();

            expect(scored.map((entry) => entry.document)).toStrictEqual(bare);
        });

        it("throws when called without a staged .withSearchIndex()/.withGeoIndex()", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await expect(writer.query("places").collectWithScores()).rejects.toThrow(
                /collectWithScores\(\) requires a staged \.withSearchIndex\(\.\.\.\) or \.withGeoIndex\(\.\.\.\)/u,
            );
        });

        // Same composition guarantee as the search-side test in
        // `ctx-db.search.test.ts`: RLS pushes its row policy down as a
        // `.filter()` on this exact reader object (see
        // `packages/server/src/rls/middleware.ts`'s `query()`), so
        // `.collectWithScores()` must respect it exactly like `.collect()` does.
        it("respects a .filter() staged before it, same as .collect()", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("places", { location: BROOKLYN, name: "brooklyn" });
            await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });

            const kept = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, 20_000))
                .filter((document) => document["name"] === "brooklyn")
                .collectWithScores();

            expect(kept.map((entry) => entry.document["name"])).toStrictEqual(["brooklyn"]);
        });
    });

    // Input validation: a malformed query is rejected up front (BAD_REQUEST)
    // instead of silently paying for a scan that can only ever return [].
    // The builder throws synchronously — the throw happens while `withGeoIndex`
    // runs the `build` callback, before any query executes.
    describe("input validation", () => {
        it("rejects .within() with transposed lat corners", () => {
            expect.assertions(1);

            const writer = setupWriter();

            expect(() =>
                writer.query("places").withGeoIndex("by_location", (q) => q.within({ ne: { lat: 5, lng: -73 }, sw: { lat: 10, lng: -74 } })),
            ).toThrow(/transposed/u);
        });

        it("rejects a .within() box crossing the antimeridian", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            // A row that would fall inside the intended (wrap-around) box, so a
            // silent [] would be indistinguishable from "no data here".
            await writer.insert("places", { location: { lat: 40, lng: 179 }, name: "near-dateline" });

            expect(() =>
                writer.query("places").withGeoIndex("by_location", (q) => q.within({ ne: { lat: 41, lng: -170 }, sw: { lat: 39, lng: 170 } })),
            ).toThrow(/antimeridian/u);

            // The row genuinely exists and is inside the intended box — proof
            // the rejected shape was not simply "no data here".
            const found = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.within({ ne: { lat: 41, lng: 180 }, sw: { lat: 39, lng: 170 } }))
                .collect();

            expect(found.map((document) => document["name"])).toStrictEqual(["near-dateline"]);
        });

        it.each([
            ["negative", -5],
            ["NaN", Number.NaN],
            ["zero", 0],
            ["Infinity", Number.POSITIVE_INFINITY],
        ])("rejects .near() with a %s radius", (_label, radiusMeters) => {
            expect.assertions(1);

            const writer = setupWriter();

            expect(() => writer.query("places").withGeoIndex("by_location", (q) => q.near(TIMES_SQUARE, radiusMeters))).toThrow(
                /radiusMeters must be a finite number > 0/u,
            );
        });

        it("rejects a .near() point with an out-of-range or non-finite lat/lng", () => {
            expect.assertions(3);

            const writer = setupWriter();

            expect(() => writer.query("places").withGeoIndex("by_location", (q) => q.near({ lat: 91, lng: 0 }, 1000))).toThrow(
                /finite lat in \[-90, 90\]/u,
            );
            expect(() => writer.query("places").withGeoIndex("by_location", (q) => q.near({ lat: 0, lng: 200 }, 1000))).toThrow(
                /finite lat in \[-90, 90\]/u,
            );
            expect(() => writer.query("places").withGeoIndex("by_location", (q) => q.near({ lat: Number.NaN, lng: 0 }, 1000))).toThrow(
                /finite lat in \[-90, 90\]/u,
            );
        });

        it("rejects a .within() box with an out-of-range corner", () => {
            expect.assertions(2);

            const writer = setupWriter();

            expect(() =>
                writer.query("places").withGeoIndex("by_location", (q) => q.within({ ne: { lat: 91, lng: -73 }, sw: { lat: 40, lng: -74 } })),
            ).toThrow(/finite lat in \[-90, 90\]/u);
            expect(() =>
                writer.query("places").withGeoIndex("by_location", (q) => q.within({ ne: { lat: 41, lng: 200 }, sw: { lat: 40, lng: -74 } })),
            ).toThrow(/finite lat in \[-90, 90\]/u);
        });

        it("does not reject well-formed inputs (no regression)", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await writer.insert("places", { location: TIMES_SQUARE, name: "times-square" });

            // A degenerate point box (sw === ne) over a row at exactly those
            // coordinates still matches — inclusive edges are unaffected.
            const pointBox = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.within({ ne: TIMES_SQUARE, sw: TIMES_SQUARE }))
                .collect();

            expect(pointBox.map((document) => document["name"])).toStrictEqual(["times-square"]);

            // A box touching +180 exactly is accepted (not treated as crossing).
            const touchingAntimeridian = await writer
                .query("places")
                .withGeoIndex("by_location", (q) => q.within({ ne: { lat: 41, lng: 180 }, sw: { lat: 40, lng: 170 } }))
                .collect();

            expect(touchingAntimeridian).toStrictEqual([]);
        });
    });
});
