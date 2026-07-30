import { byCodepoint, MAP_VERSION } from "./score-advisor";
import type { AdvisorMap, Coverage } from "./types";

/** Every verdict `Coverage` may take, for validating an artifact read off disk. */
const COVERAGE_VALUES: ReadonlySet<string> = new Set<Coverage>(["clean", "exempt", "failing", "warned"]);

/** One procedure whose score moved between the baseline and the current map. */
interface ProcedureDelta {
    /** Score in the current map. */
    after: number;
    /** Score in the baseline. */
    before: number;
    /** `file#exportName`. */
    id: string;
}

/**
 * The verdict a CI gate acts on.
 *
 * A discriminated union on purpose: the obvious shape (a flat object with
 * `comparable: boolean` and `regressed: false` when incomparable) reads as
 * "no regression" for a missing, stale, or corrupt baseline, so a gate written
 * as `if (diff.regressed)` silently passes forever after a `MAP_VERSION` bump.
 * Forcing the caller to narrow makes that mistake unrepresentable.
 */
type BaselineComparison =
    | {
          comparable: false;
          /** Why no comparison was possible — a gate should treat this as "cannot verify", not "clean". */
          reason: "version-mismatch";
      }
    | {
          comparable: true;
          /** Procedures present in both maps whose score fell, sorted by `id`. */
          dropped: ProcedureDelta[];
          /** Procedures that are `failing` now and were not before — new rows included. */
          newFailing: string[];
          /** `true` when the project bucket gained rules, even if its saturated score did not move. */
          projectRegressed: boolean;
          /** `true` when any signal above fired. */
          regressed: boolean;
          /** Current global score less the baseline's; negative is a regression. */
          scoreDelta: number;
      };

/** A finite number, i.e. one that can be compared and round-tripped through JSON. */
const isScore = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

/** Structural check for one row of a baseline read off disk. */
const isProcedureRow = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const row = value as Record<string, unknown>;

    return typeof row.id === "string" && isScore(row.score) && typeof row.coverage === "string" && COVERAGE_VALUES.has(row.coverage);
};

/** Structural check for the project bucket of a baseline read off disk. */
const isProjectBucket = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const bucket = value as Record<string, unknown>;

    return Array.isArray(bucket.checks) && isScore(bucket.score);
};

/**
 * Diff a freshly-scored map against a committed one.
 *
 * Four independent regression signals, any of which fails a gate: the global
 * score fell, a procedure that existed before got worse, a procedure started
 * failing, or the project bucket gained rules. The per-procedure signals matter
 * because a refactor can leave the global mean flat while gutting one handler;
 * the project-rule-count signal matters because that bucket's score saturates at
 * 0, after which new schema errors would otherwise be free.
 */
const compareToBaseline = (current: AdvisorMap, baseline: AdvisorMap): BaselineComparison => {
    if (baseline.version !== current.version) {
        return { comparable: false, reason: "version-mismatch" };
    }

    const before = new Map(baseline.procedures.map((entry) => [entry.id, entry]));
    const dropped: ProcedureDelta[] = [];
    const newFailing: string[] = [];

    for (const entry of current.procedures) {
        if (entry.coverage === "exempt") {
            continue;
        }

        const previous = before.get(entry.id);

        if (previous !== undefined && previous.coverage !== "exempt" && entry.score < previous.score) {
            dropped.push({ after: entry.score, before: previous.score, id: entry.id });
        }

        if (entry.coverage === "failing" && previous?.coverage !== "failing") {
            newFailing.push(entry.id);
        }
    }

    dropped.sort((a, b) => byCodepoint(a.id, b.id));
    newFailing.sort(byCodepoint);

    const scoreDelta = current.score - baseline.score;
    const projectRegressed = current.project.checks.length > baseline.project.checks.length;

    return {
        comparable: true,
        dropped,
        newFailing,
        projectRegressed,
        regressed: scoreDelta < 0 || dropped.length > 0 || newFailing.length > 0 || projectRegressed,
        scoreDelta,
    };
};

/**
 * Narrow a parsed `lunora.advisor.map.json` to an {@link AdvisorMap}, returning
 * `undefined` when it is not one this build can read.
 *
 * Validates the header *and* every procedure row, because `compareToBaseline`
 * dereferences `entry.id` / `entry.score` / `entry.coverage`: a truncated or
 * merge-conflicted baseline with a `null` row would otherwise crash the gate,
 * and a row of `{}` would compare as a silent no-op. Non-finite scores are
 * rejected for the same reason — `NaN < 0` is `false`, which reads as "no
 * regression".
 */
const parseAdvisorMap = (value: unknown): AdvisorMap | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;

    if (candidate.version !== MAP_VERSION || !isScore(candidate.score)) {
        return undefined;
    }

    if (!Array.isArray(candidate.procedures) || !candidate.procedures.every((row: unknown) => isProcedureRow(row))) {
        return undefined;
    }

    if (!isProjectBucket(candidate.project)) {
        return undefined;
    }

    return value as AdvisorMap;
};

export { compareToBaseline, parseAdvisorMap };
export type { BaselineComparison, ProcedureDelta };
