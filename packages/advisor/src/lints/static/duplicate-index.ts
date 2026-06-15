import emit from "../../finding";
import type { AdvisorIndex } from "../../schema";
import type { Lint } from "../../types";

/** True when `a`'s columns are a leading prefix of `b`'s (so `b` already serves every lookup `a` does). */
const isLeadingPrefix = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
    if (a.length > b.length) {
        return false;
    }

    return a.every((field, position) => field === b[position]);
};

/**
 * Lunora port of splinter's `0009_duplicate_index`.
 *
 * A btree secondary index is redundant when another index already serves every
 * lookup it does — i.e. its columns are a leading prefix of the other's
 * (SQLite's leftmost-prefix rule means `["a", "b"]` already covers `["a"]`).
 * Exact duplicates are the degenerate case. A redundant index is pure overhead:
 * extra storage and a write amplified on every insert/update/delete.
 *
 * Only `kind: "index"` participates — search/rank/vector indexes are distinct
 * structures, never redundant with a btree. A `unique` index is never reported
 * as redundant even when its columns are a prefix: it enforces a constraint the
 * covering index does not, so dropping it would change behavior.
 */
const duplicateIndex: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A secondary index is redundant because another index already covers every lookup it serves (its columns are a leading prefix of the other's). The redundant index costs storage and is maintained on every write for no read benefit.",
    facing: "INTERNAL",
    level: "INFO",
    name: "duplicate_index",
    remediation: "Drop the redundant index; the covering index already serves its lookups.",
    run: (context) => {
        const findings = [];

        for (const table of context.schema.tables) {
            const secondary = table.indexes.filter((index): index is AdvisorIndex => index.kind === "index");

            for (const candidate of secondary) {
                // A unique index carries a constraint a covering index doesn't — never redundant.
                if (candidate.unique === true) {
                    continue;
                }

                // Find another index that strictly covers this one. When two indexes
                // are exact duplicates, the tie is broken by name so exactly one of
                // the pair is reported (the later-sorted one is the "redundant" side).
                const cover = secondary.find((other) => {
                    if (other === candidate) {
                        return false;
                    }

                    if (!isLeadingPrefix(candidate.fields, other.fields)) {
                        return false;
                    }

                    const sameLength = candidate.fields.length === other.fields.length;

                    return sameLength ? candidate.name > other.name : true;
                });

                if (!cover) {
                    continue;
                }

                findings.push(
                    emit(duplicateIndex, {
                        cacheKey: `duplicate_index:${table.name}:${candidate.name}`,
                        detail: `Index "${candidate.name}" on table "${table.name}" (${candidate.fields.join(", ")}) is redundant — index "${cover.name}" (${cover.fields.join(", ")}) already covers its lookups.`,
                        metadata: {
                            coveredBy: { fields: cover.fields, name: cover.name },
                            fields: candidate.fields,
                            index: candidate.name,
                            table: table.name,
                        },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Duplicate / redundant index",
};

export default duplicateIndex;
