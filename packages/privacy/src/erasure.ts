/**
 * The erasure decisions as pure functions: what happens to one row, how a batched
 * drain repeats until a table is empty, and whether the verify step may report the
 * erasure as complete. The erasure workflow calls these; the rules are tested here.
 */
import { LunoraError } from "@lunora/errors";

import type { TableErasure } from "./dataset";
import type { RetainDirective, RetentionRule } from "./rules";
import { retainUntil } from "./rules";

/** Rows per table per call. A drain step never erases more, so one step stays inside the platform's limits. */
const ERASE_BATCH = 100;

/** What happens to a row when its table is erased. */
type Disposition = { readonly kind: "delete" } | { readonly kind: "anonymise" } | { readonly kind: "keep"; readonly until: Date };

const retainDisposition = (
    directive: RetainDirective,
    row: { readonly [column: string]: unknown },
    rules: ReadonlyMap<string, RetentionRule>,
    now: Date,
): Disposition => {
    const rule = rules.get(directive.rule);

    if (rule === undefined) {
        throw new LunoraError("BAD_REQUEST", `Retention rule "${directive.rule}" is not in the preset set.`);
    }

    const fromColumn = directive.from === undefined ? undefined : row[directive.from];
    let start = now;

    if (fromColumn instanceof Date) {
        start = fromColumn;
    } else if (typeof fromColumn === "number") {
        start = new Date(fromColumn);
    }
    const until = retainUntil(rule, start);

    return until.getTime() > now.getTime() ? { kind: "keep", until } : { kind: "delete" };
};

/**
 * Decide what happens to a row. A `retain` directive keeps the row while its rule's
 * period is running, and deletes it after. `from` names the date column that starts
 * the period; without it, the rule's period starts at `now` (the erasure date).
 */
const dispositionOf = (erase: TableErasure, row: { readonly [column: string]: unknown }, rules: ReadonlyMap<string, RetentionRule>, now: Date): Disposition => {
    if (erase === "delete" || erase === "anonymise") {
        return { kind: erase };
    }

    return retainDisposition(erase, row, rules, now);
};

/**
 * Run a batched step until it reports there is nothing left. A step that never
 * finishes is an error, not a silent success: the erasure stops and an operator
 * reads why.
 */
const drainUntilEmpty = async (step: () => Promise<{ readonly hasMore: boolean }>, maxRounds = 10_000): Promise<number> => {
    for (let round = 1; round <= maxRounds; round += 1) {
        // Batches run one after another on purpose: each one reads the rows the last one left.
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see the comment above
        const result = await step();

        if (!result.hasMore) {
            return round;
        }
    }

    throw new LunoraError("INTERNAL", `Erasure did not finish within ${String(maxRounds)} batches; the table may be refilling.`);
};

/** The verify step's answer: complete only when every table reads zero rows afterwards. */
interface VerifyResult {
    readonly complete: boolean;
    readonly leftover: ReadonlyArray<string>;
}

/** Check the counts read after erasure. A table with rows still in it is a leftover, and the erasure is not complete. */
const verifyErasure = (remaining: Readonly<Record<string, number>>): VerifyResult => {
    const leftover = Object.entries(remaining)
        .filter(([, count]) => count > 0)
        .map(([table]) => table)
        .toSorted((a, b) => a.localeCompare(b));

    return { complete: leftover.length === 0, leftover };
};

export { type Disposition, dispositionOf, drainUntilEmpty, ERASE_BATCH, verifyErasure, type VerifyResult };
