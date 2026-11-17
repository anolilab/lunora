import { ConflictError } from "@lunora/shard-engine";

import type { D1Exec } from "../../src/d1-ctx-db";

interface ObservedExec {
    /** Statements of the batched ownership probe (the only ones that select a `slot`). */
    batched: () => number;
    exec: D1Exec;
    /** Bare `SELECT 1` probes of one row's own table. */
    perRow: () => number;
}

/**
 * Wrap `inner`, counting the import's ownership probes. `failWrite` makes any matching write throw a unique-index
 * `ConflictError` (as a companion write that breaches an index would); `failProbes` makes the per-row probe throw.
 */
const observeExec = (inner: D1Exec, failWrite?: RegExp, failProbes = false): ObservedExec => {
    let batched = 0;
    let perRow = 0;

    return {
        batched: () => batched,
        exec: {
            all: async (query, parameters) => {
                batched += /AS slot/u.test(query) ? 1 : 0;

                const isRowProbe = /^\s*SELECT 1 FROM "alpha" WHERE "id" = \?/u.test(query);

                perRow += isRowProbe ? 1 : 0;

                return failProbes && isRowProbe ? Promise.reject(new Error("probe unavailable")) : inner.all(query, parameters);
            },
            run: (query, parameters) =>
                failWrite?.test(query) === true ? Promise.reject(new ConflictError("unique index breached")) : inner.run(query, parameters),
        },
        perRow: () => perRow,
    };
};

export { observeExec };
export type { ObservedExec };
