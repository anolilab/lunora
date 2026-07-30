import type { AdvisorProcedureProtection } from "../procedure-protections";
import type { Level } from "../types";
import type { CheckResult, Coverage, Grade } from "./types";

/**
 * Global-mean weights. A public handler is the attack and traffic surface, so it
 * counts double; internal ones are server-called and count half. `query` is
 * read-only and draws a thinner rule set, so — mirroring `evlog map`'s
 * "page wins when both apply" — a query is halved regardless of visibility,
 * preventing one check from swinging a mostly-read app's grade.
 */
const PUBLIC_WEIGHT = 2;
const INTERNAL_WEIGHT = 0.5;
const QUERY_WEIGHT = 0.5;

/** Grade thresholds, mirroring `evlog map`'s bands. */
const EXCELLENT_FLOOR = 90;
const GOOD_FLOOR = 70;

/** Every procedure starts here and loses its failed checks' weights. */
const PERFECT_SCORE = 100;

/**
 * Penalty applied when a lint that declares no explicit `weight` fires, keyed by
 * the finding's severity. A definite problem costs more than an advisory nudge;
 * the ladder is deliberately coarse (5 ERRORs, or 10 WARNs, take a procedure
 * from clean to zero). `evlog map` uses a flat fallback of 10 — Lunora spreads
 * it across `Level` because our lints already carry a calibrated severity.
 */
const DEFAULT_WEIGHT_BY_LEVEL: Readonly<Record<Level, number>> = { ERROR: 20, INFO: 5, WARN: 10 };

/** Score at or above which a procedure is `partial` rather than `dark`. */
const PARTIAL_FLOOR = 50;

/** Weight of the project/schema entry in the global mean. */
const PROJECT_WEIGHT = 1;

/**
 * This row's pull on the global mean. See the weight constants for the
 * rationale; `query` wins over `visibility` when both apply.
 */
const procedureWeight = (procedure: Pick<AdvisorProcedureProtection, "kind" | "visibility">): number => {
    if (procedure.kind === "query") {
        return QUERY_WEIGHT;
    }

    return procedure.visibility === "public" ? PUBLIC_WEIGHT : INTERNAL_WEIGHT;
};

/**
 * Score one procedure: start at 100, subtract each fired check's weight, clamp
 * at 0 so a pathological file cannot drag the global mean negative.
 */
const scoreProcedure = (checks: ReadonlyArray<CheckResult>): number => {
    const penalty = checks.reduce((total, check) => total + check.weight, 0);

    return Math.max(0, PERFECT_SCORE - penalty);
};

/**
 * Weighted mean of the supplied entries, rounded to an integer so a committed
 * baseline diffs cleanly. Callers pass only non-exempt rows. With no entries at
 * all the score is a vacuous 100 — nothing was in scope to fail.
 */
const scoreGlobal = (entries: ReadonlyArray<{ score: number; weight: number }>): number => {
    const totalWeight = entries.reduce((total, entry) => total + entry.weight, 0);

    if (totalWeight === 0) {
        return PERFECT_SCORE;
    }

    const weighted = entries.reduce((total, entry) => total + entry.score * entry.weight, 0);

    return Math.round(weighted / totalWeight);
};

/** Band a 0–100 score, mirroring `evlog map`'s thresholds. */
const gradeFromScore = (score: number): Grade => {
    if (score >= EXCELLENT_FLOOR) {
        return "excellent";
    }

    if (score >= GOOD_FLOOR) {
        return "good";
    }

    if (score >= PARTIAL_FLOOR) {
        return "needs-work";
    }

    return "at-risk";
};

/**
 * Coverage verdict for a scored procedure. `exempt` is decided by the caller
 * (an explicit opt-out list), never by the score.
 */
const coverageFromScore = (score: number): Exclude<Coverage, "exempt"> => {
    if (score === PERFECT_SCORE) {
        return "instrumented";
    }

    return score >= PARTIAL_FLOOR ? "partial" : "dark";
};

export { coverageFromScore, DEFAULT_WEIGHT_BY_LEVEL, gradeFromScore, PARTIAL_FLOOR, procedureWeight, PROJECT_WEIGHT, scoreGlobal, scoreProcedure };
