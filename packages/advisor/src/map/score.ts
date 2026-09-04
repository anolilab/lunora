import type { AdvisorProcedureProtection } from "../procedure-protections";
import type { Level } from "../types";
import type { CheckResult, Coverage, Grade, SensitivityLevel, WeightedEntry } from "./types";

/**
 * Global-mean weights. A public handler is the attack and traffic surface, so it
 * counts double; internal ones are server-called and count half. `query` is
 * read-only and draws a thinner rule set, so a query is halved regardless of
 * visibility — kind wins over visibility when both apply, preventing one check
 * from swinging a mostly-read app's grade.
 */
const PUBLIC_WEIGHT = 2;
const INTERNAL_WEIGHT = 0.5;
const QUERY_WEIGHT = 0.5;

/**
 * Multiplier for a procedure `classifySensitivity` marked `high`. Visibility
 * says who can reach a handler; sensitivity says what it touches — an internal
 * mutation writing the users table deserves more of the grade than a public one
 * that returns a static list, and only this factor can express that.
 */
const SENSITIVE_MULTIPLIER = 2;

/** Grade band thresholds. */
const EXCELLENT_FLOOR = 90;
const GOOD_FLOOR = 70;

/** Every procedure starts here and loses its failed checks' weights. */
const PERFECT_SCORE = 100;

/**
 * Share of the total procedure weight given to the project bucket, and the floor
 * that keeps it meaningful in a tiny app.
 *
 * A flat weight of 1 does **not** work: with 20 public mutations (weight 40) a
 * project score of 0 moves the global mean by under half a point, which
 * `Math.round` then erases entirely — schema debt would be free. Scaling with
 * the procedure population keeps the bucket worth a fixed ~1/6 of the grade at
 * any app size, which is what "schema debt still moves the grade" has to mean.
 */
const PROJECT_WEIGHT_SHARE = 0.2;
const PROJECT_MIN_WEIGHT = 1;

/** Score at or above which a procedure is `warned` rather than `failing`. */
const FAILING_FLOOR = 50;

/**
 * Penalty applied when a lint fires, keyed by the finding's severity. Severity
 * is the only input: a lint carries no per-lint weight of its own, so two rules
 * at the same level cost the same. A definite problem costs more than an
 * advisory nudge;
 * the ladder is deliberately coarse (5 distinct ERROR rules, or 10 WARN rules,
 * take a procedure from clean to zero). The ladder is keyed on `Level` rather than
 * a single flat penalty because our lints already carry a calibrated severity.
 */
const DEFAULT_WEIGHT_BY_LEVEL: Readonly<Record<Level, number>> = { ERROR: 20, INFO: 5, WARN: 10 };

/** Severity ordering, used to keep the worst level when one rule fires repeatedly. */
const LEVEL_RANK: Readonly<Record<Level, number>> = { ERROR: 3, INFO: 1, WARN: 2 };

/**
 * Coerce a weight into a usable penalty.
 *
 * Guards the artifact against a hand-supplied `CheckResult`: a negative weight
 * would push a score _above_ 100 (and a "better than perfect" procedure then
 * fails the `score === PERFECT_SCORE` clean test), while `NaN` poisons the
 * global mean, survives `JSON.stringify` as `null`, and makes `scoreDelta < 0`
 * false — a silent CI pass.
 */
const normalizeWeight = (weight: number): number => (Number.isFinite(weight) && weight >= 0 ? weight : 0);

/** Penalty for one finding, from its severity. */
const weightFor = (level: Level): number => DEFAULT_WEIGHT_BY_LEVEL[level];

/** Keep the worse of two severities when one rule fires more than once on a procedure. */
const worstLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

/**
 * This row's pull on the global mean. See the weight constants for the
 * rationale; `query` wins over `visibility` when both apply.
 */
const procedureWeight = (procedure: Pick<AdvisorProcedureProtection, "kind" | "visibility">, sensitivity: SensitivityLevel = "none"): number => {
    const byVisibility = procedure.visibility === "public" ? PUBLIC_WEIGHT : INTERNAL_WEIGHT;
    const base = procedure.kind === "query" ? QUERY_WEIGHT : byVisibility;

    return sensitivity === "high" ? base * SENSITIVE_MULTIPLIER : base;
};

/** Weight of the project bucket, scaled against the procedures it competes with. */
const projectWeight = (totalProcedureWeight: number): number => Math.max(PROJECT_MIN_WEIGHT, totalProcedureWeight * PROJECT_WEIGHT_SHARE);

/**
 * Score one procedure: start at 100, subtract each fired rule's weight, and hold
 * the result inside `[0, 100]` so no input can produce an out-of-range score.
 * Checks are already deduplicated per rule, so a lint that fires on five call
 * sites costs the same as one that fires once — one rule, one penalty.
 */
const scoreProcedure = (checks: ReadonlyArray<CheckResult>): number => {
    const penalty = checks.reduce((total, check) => total + normalizeWeight(check.weight), 0);

    return Math.min(PERFECT_SCORE, Math.max(0, PERFECT_SCORE - penalty));
};

/**
 * Weighted mean of the supplied entries, rounded to an integer so a committed
 * baseline diffs cleanly. Callers pass only non-exempt rows. With no entries at
 * all the score is a vacuous 100 — nothing was in scope to fail.
 */
const scoreGlobal = (entries: ReadonlyArray<WeightedEntry>): number => {
    const totalWeight = entries.reduce((total, entry) => total + entry.weight, 0);

    if (totalWeight === 0) {
        return PERFECT_SCORE;
    }

    const weighted = entries.reduce((total, entry) => total + entry.score * entry.weight, 0);

    return Math.round(weighted / totalWeight);
};

/** Band a 0–100 score. */
const gradeFromScore = (score: number): Grade => {
    if (score >= EXCELLENT_FLOOR) {
        return "excellent";
    }

    if (score >= GOOD_FLOOR) {
        return "good";
    }

    if (score >= FAILING_FLOOR) {
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
        return "clean";
    }

    return score >= FAILING_FLOOR ? "warned" : "failing";
};

export {
    coverageFromScore,
    DEFAULT_WEIGHT_BY_LEVEL,
    gradeFromScore,
    normalizeWeight,
    procedureWeight,
    projectWeight,
    scoreGlobal,
    scoreProcedure,
    weightFor,
    worstLevel,
};
