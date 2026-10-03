/**
 * The work budget and least-fixed-point memo one impl's taint queries share:
 * {@link VerdictBudget}.
 */
import type { ts } from "ts-morph";

/**
 * How many uncached verdicts ONE top-level taint query may compute before every
 * further verdict fails closed. A cycle makes the verdicts on it uncachable, so
 * a recursive helper re-derived from many call sites could otherwise cost
 * exponential time. The budget is reset per query and cache hits are free, so
 * a long-lived model (a dev loop reusing the project) never drifts. Realistic
 * impls, and a depth-14 chain of helpers that each call the next twice, stay far
 * below it.
 */
const WORK_BUDGET = 50_000;

/** Memoized verdicts plus the keys being computed. */
interface VerdictTable {
    inProgress: Set<ts.Node>;
    verdicts: Map<ts.Node, boolean>;
}

/** An empty {@link VerdictTable}. */
const createVerdictTable = (): VerdictTable => {
    return { inProgress: new Set(), verdicts: new Map() };
};

/**
 * Counts the work of one top-level query and the cuts made on the way. A cut —
 * a cycle broken, a bound or the budget exceeded — makes every verdict computed
 * across it provisional, so {@link VerdictBudget.memoized} does not cache it.
 * Recursion resolves to the least fixed point: a cycle adds nothing of its own.
 */
class VerdictBudget {
    /** How many cuts were made so far; compare before and after a computation to see whether it crossed one. */
    public cuts = 0;

    private work = 0;

    /** Start a new top-level query with the full budget. */
    public reset(): void {
        this.work = 0;
    }

    /** Record a cut where a bound was exceeded; `true`, the fail-closed verdict the caller returns. */
    public cut(): true {
        this.cuts += 1;

        return true;
    }

    /** Count one unit of work; past {@link WORK_BUDGET}, cut and say so — the caller then fails closed. */
    public spend(): boolean {
        this.work += 1;

        return this.work > WORK_BUDGET && this.cut();
    }

    /** The verdict for `key` in `table`, computed once; a key re-entered while in progress is a cycle, cut as `false`. */
    public memoized(key: ts.Node, compute: () => boolean, table: VerdictTable): boolean {
        const known = table.verdicts.get(key);

        if (known !== undefined) {
            return known;
        }

        if (table.inProgress.has(key)) {
            this.cuts += 1;

            return false;
        }

        if (this.spend()) {
            return true;
        }

        const cutsBefore = this.cuts;

        table.inProgress.add(key);

        let verdict: boolean;

        try {
            verdict = compute();
        } finally {
            table.inProgress.delete(key);
        }

        if (this.cuts === cutsBefore) {
            table.verdicts.set(key, verdict);
        }

        return verdict;
    }
}

export { createVerdictTable, VerdictBudget };
export type { VerdictTable };
