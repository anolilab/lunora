import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a declared `.geoIndex(name, { field })` that no handler queries via
 * `withGeoIndex(name, …)`.
 *
 * A geo index maintains a geohash companion column on the row: every write stamps
 * it, every byte of storage holds it. If nothing ever reads it through
 * `withGeoIndex(name, q => q.near(…) | q.within(…))` the companion is pure dead
 * overhead — the geo analogue of a dead regular index. Cross-references every geo
 * index in the schema against the set of index names some handler references via
 * `withGeoIndex("&lt;name>")`.
 *
 * Suppressed entirely when any usage passes a non-literal name
 * (`withGeoIndex(someVariable, …)`), because a dynamic reference could target any
 * declared geo index — flagging "unused" then would be a false positive. Only
 * runs when the usage feeder supplied evidence (`context.geoIndexUsages`
 * present); a runtime caller with no evidence flags nothing.
 */
const geoIndexUnused: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `.geoIndex(name, { field })` is declared but no handler reads it via `withGeoIndex(name, …)`. The geohash companion column is maintained on every write and read by nothing — dead overhead, the geo analogue of a dead index.",
    facing: "INTERNAL",
    level: "INFO",
    name: "geo_index_unused",
    remediation:
        'Query the index from a handler with `ctx.db.query("<table>").withGeoIndex("<name>", q => q.near(point, radius))`, or drop the `.geoIndex(...)` declaration so writes stop maintaining its geohash companion.',
    run: (context) => {
        // No usage evidence supplied → nothing to assert (mirrors workflow_unused).
        if (context.geoIndexUsages === undefined) {
            return [];
        }

        const usages = context.geoIndexUsages;

        // A dynamic `withGeoIndex(<expr>, …)` could target any geo index — can't
        // prove any are unused, so stay silent rather than emit false positives.
        if (usages.some((usage) => usage.indexName === "")) {
            return [];
        }

        const used = new Set(usages.map((usage) => usage.indexName));
        const findings = [];

        for (const table of context.schema.tables) {
            for (const index of table.indexes) {
                if (index.kind !== "geo" || used.has(index.name)) {
                    continue;
                }

                findings.push(
                    emit(geoIndexUnused, {
                        cacheKey: `geo_index_unused:${table.name}:${index.name}`,
                        detail: `No handler reads geo index "${index.name}" on table "${table.name}" via \`withGeoIndex("${index.name}", …)\` — it's declared but never queried, so its geohash companion is maintained on every write for nothing.`,
                        metadata: { index: index.name, table: table.name },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Geo index is declared but never queried",
};

export default geoIndexUnused;
