import emit from "../../finding";
import type { Lint } from "../../types";
import { columnKind } from "../helpers";

/**
 * A correctness lint exploiting Lunora's static edge: a `.geoIndex(name, { field })`
 * maintains a geohash companion over a `v.geoPoint()` column, and
 * `withGeoIndex(...).near()/.within()` reads its `lat`/`lng`. If `field` is any
 * other type, the companion can't be built from `{ lat, lng }` and the index is
 * dead — it can never answer a geo query. Catching it at codegen time beats a
 * silently-empty proximity result at runtime.
 */
const geoIndexFieldNotGeopoint: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `.geoIndex(name, { field })` points at a column that is not a `v.geoPoint()`, so its geohash companion can't be built and `withGeoIndex(...)` can never match.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "geo_index_field_not_geopoint",
    remediation: "Point the geo index at a `v.geoPoint()` column, or change the column's type to `v.geoPoint()`.",
    run: (context) => {
        const findings = [];

        for (const table of context.schema.tables) {
            for (const index of table.indexes) {
                if (index.kind !== "geo") {
                    continue;
                }

                const field = index.fields[0];

                if (field === undefined) {
                    continue;
                }

                // Skip when the feeder doesn't carry column kinds (can't decide).
                // Own-property lookup, so an index over an undeclared `toString`
                // reads as unknown instead of inheriting from `Object.prototype`.
                const kind = columnKind(table, field);

                if (kind === undefined || kind === "geoPoint") {
                    continue;
                }

                findings.push(
                    emit(geoIndexFieldNotGeopoint, {
                        cacheKey: `geo_index_field_not_geopoint:${table.name}:${index.name}:${field}`,
                        detail: `Geo index "${index.name}" on table "${table.name}" indexes column "${field}", which is a ${kind}, not a v.geoPoint().`,
                        metadata: { field, index: index.name, kind, table: table.name },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Geo index field is not a geoPoint",
};

export default geoIndexFieldNotGeopoint;
