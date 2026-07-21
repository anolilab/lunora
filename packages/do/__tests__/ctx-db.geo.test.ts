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

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, geoSchema);

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

    return createShardContextDatabase({ clock, idGenerator, schema: geoSchema, sql: harness.sql });
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
});
