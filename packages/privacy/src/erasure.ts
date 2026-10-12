/**
 * The erasure decisions as pure functions: what happens to one row, how a batched
 * drain repeats until a table is empty, and whether the verify step may report the
 * erasure as complete. The erasure workflow calls these; the rules are tested here.
 */
import { LunoraError } from "@lunora/errors";

import type { Dataset, TableErasure } from "./dataset";
import type { PrivacyPreset, RetainDirective, RetentionRule } from "./rules";
import { retainUntil, retentionRulesOf } from "./rules";

/** Rows per table per call. A drain step never erases more, so one step stays inside the platform's limits. */
const ERASE_BATCH = 100;

/** What happens to a row when its table is erased. */
type Disposition = { readonly kind: "delete" } | { readonly kind: "anonymise" } | { readonly kind: "keep"; readonly until: Date };

/**
 * The date that starts a row's retention period. Without `from`, the period starts at `now`
 * (the erasure date). A named column must hold a valid `Date` or epoch milliseconds: any other
 * value would silently restart the period at the erasure date, so it is refused.
 */
const periodStart = (directive: RetainDirective, row: { readonly [column: string]: unknown }, now: Date, where: string): Date => {
    if (directive.from === undefined) {
        return now;
    }

    const value = row[directive.from];
    const start = value instanceof Date || typeof value === "number" ? new Date(value) : undefined;

    if (start === undefined || Number.isNaN(start.getTime())) {
        throw new LunoraError(
            "BAD_REQUEST",
            `Retention for ${where} starts from column "${directive.from}", which must hold a Date or epoch milliseconds; got ${value === null ? "null" : typeof value}.`,
        );
    }

    return start;
};

/** Keep a row while its rule's period is running, and delete it after. */
const retainDisposition = (
    directive: RetainDirective,
    row: { readonly [column: string]: unknown },
    rules: ReadonlyMap<string, RetentionRule>,
    now: Date,
    where: string,
): Disposition => {
    const rule = rules.get(directive.rule);

    if (rule === undefined) {
        throw new LunoraError("BAD_REQUEST", `Retention rule "${directive.rule}" is not in the preset set.`);
    }

    const until = retainUntil(rule, periodStart(directive, row, now, where));

    return until.getTime() > now.getTime() ? { kind: "keep", until } : { kind: "delete" };
};

/** The package's verdict for one row, which the app's `eraseBatch` applies. */
type RowDisposition = (dataset: Dataset, table: string, row: { readonly [column: string]: unknown }, now: Date) => Disposition;

/**
 * Bind the presets' retention rules into the verdict `eraseBatch` receives. A table with no
 * `erase` is deleted, `delete` and `anonymise` apply as written, and a `retain` directive keeps
 * the row while its rule's period is running.
 */
const dispositionFor =
    (rules: ReadonlyMap<string, RetentionRule>): RowDisposition =>
    (dataset, table, row, now) => {
        const erase: TableErasure = dataset.tables[table]?.erase ?? "delete";

        if (erase === "delete" || erase === "anonymise") {
            return { kind: erase };
        }

        return retainDisposition(erase, row, rules, now, `${dataset.id}.${table}`);
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

/**
 * Check the counts read after erasure. A table with more rows than `kept` allows (rows a
 * retention rule still holds) is a leftover, and the erasure is not complete.
 */
const verifyErasure = (remaining: Readonly<Record<string, number>>, kept: Readonly<Record<string, number>> = {}): VerifyResult => {
    const leftover = Object.entries(remaining)
        .filter(([table, count]) => count > (kept[table] ?? 0))
        .map(([table]) => table)
        .toSorted((a, b) => a.localeCompare(b));

    return { complete: leftover.length === 0, leftover };
};

/** The verdict for the rules a preset set (see {@link dispositionFor}), so every caller binds the same rules. */
const dispositionForPresets = (presets: ReadonlyArray<PrivacyPreset>): RowDisposition => dispositionFor(retentionRulesOf(presets));

export { type Disposition, dispositionFor, dispositionForPresets, drainUntilEmpty, ERASE_BATCH, type RowDisposition, verifyErasure, type VerifyResult };
