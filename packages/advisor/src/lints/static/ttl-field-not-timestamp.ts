import emit from "../../finding";
import type { Lint } from "../../types";
import { columnKind } from "../helpers";

/** Column kinds that carry an epoch-millisecond instant a TTL sweep can compare against `now`. */
const TIME_KINDS = new Set(["date", "number", "timestamp"]);

/**
 * A correctness lint with no splinter analogue — Lunora's static edge again: the
 * `.ttl(field)` policy names an epoch-millisecond expiry column, and the DO alarm
 * sweep compares `field < now`. If `field` is a non-time column (a string token, a
 * boolean flag, an object), the comparison is meaningless and rows either never
 * expire or expire unpredictably — a bug the fully-declared schema catches at
 * codegen time rather than at 3am when the sweep silently misbehaves.
 */
const ttlFieldNotTimestamp: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `.ttl(field)` policy points at a column that is not an epoch-millisecond timestamp, so the alarm sweep's `field < now` comparison can't decide expiry correctly.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "ttl_field_not_timestamp",
    remediation: "Point `.ttl(field)` at a `v.timestamp()` / `v.date()` / `v.number()` (epoch-ms) column, or add such a column.",
    run: (context) => {
        const findings = [];

        for (const table of context.schema.tables) {
            const { ttl } = table;

            if (!ttl) {
                continue;
            }

            // The feeder may not carry column kinds (some runtime callers); skip
            // the check rather than guess when the type isn't known. Own-property
            // lookup, so a `.ttl("toString")` naming no declared column reads as
            // unknown instead of inheriting an `Object.prototype` member.
            const kind = columnKind(table, ttl.field);

            if (kind === undefined || TIME_KINDS.has(kind)) {
                continue;
            }

            findings.push(
                emit(ttlFieldNotTimestamp, {
                    cacheKey: `ttl_field_not_timestamp:${table.name}:${ttl.field}`,
                    detail: `Table "${table.name}" declares \`.ttl("${ttl.field}")\`, but "${ttl.field}" is a ${kind} column, not an epoch-millisecond timestamp.`,
                    metadata: { field: ttl.field, kind, table: table.name },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "TTL field is not a timestamp",
};

export default ttlFieldNotTimestamp;
