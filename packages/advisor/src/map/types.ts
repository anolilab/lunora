import type { Level } from "../types";

/** Letter band for a 0–100 score. */
type Grade = "at-risk" | "excellent" | "good" | "needs-work";

/**
 * How a single procedure came out of the lints that apply to it.
 *
 * Named for severity rather than instrumentation, because the score is driven by
 * every lint family (security, performance, schema): a verdict like
 * "uninstrumented" would claim something the map does not measure, and would
 * report a security regression as a telemetry gap. `clean` means no lint fired.
 * `exempt` rows pull no weight.
 */
type Coverage = "clean" | "exempt" | "failing" | "warned";

/**
 * One *rule* that fired against a procedure, reduced to its score contribution.
 *
 * Deduplicated by lint: a rule that fires on five call sites is one check with
 * `occurrences: 5`, costing its weight once. Counting occurrences instead would
 * let a single rule zero a procedure and would fill the artifact with identical
 * rows.
 */
interface CheckResult {
    /** Worst severity seen across this rule's occurrences. */
    level: Level;
    /** The lint id that fired, e.g. `unindexed_foreign_key`. */
    name: string;
    /** How many findings this rule produced on the procedure (>= 1). */
    occurrences: number;
    /** Points subtracted from the procedure's score — charged once, not per occurrence. */
    weight: number;
}

/** How much a procedure's failures matter — see `classifySensitivity`. */
type SensitivityLevel = "high" | "none";

/** A procedure's sensitivity plus the declarations that produced it. */
interface Sensitivity {
    /** `high` when any signal fired; `none` means no signal, not "safe". */
    level: SensitivityLevel;
    /** Human-readable signals, e.g. "writes an identity table". Empty when `none`. */
    reasons: string[];
}

/** Anything that contributes a score at a weight to the global mean. */
interface WeightedEntry {
    score: number;
    weight: number;
}

/** One scored procedure — the unit the map is built from. */
interface ProcedureScore {
    /** Rules that fired against this procedure, sorted by `name`. */
    checks: CheckResult[];
    /** Verdict derived from {@link ProcedureScore.score}. */
    coverage: Coverage;
    /** Exported binding name, e.g. `sendMessage`. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** Stable `file#exportName` identity — the baseline diff key. */
    id: string;
    /** Registration kind. */
    kind: "action" | "mutation" | "query";
    /** 0–100, starting at 100 less each fired rule's weight. */
    score: number;
    /** How much this procedure's failures matter, and why. */
    sensitivity: Sensitivity;
    /** Public (client-callable) or internal (server-called). */
    visibility: "internal" | "public";
    /** This row's weight in the global mean — see `procedureWeight`. */
    weight: number;
}

/**
 * Findings that name no procedure — schema-shape and project-wide lints
 * (missing index, circular FK, plaintext wrangler secret), plus any finding
 * whose `file`/`exportName` matches no declared procedure.
 *
 * Folded into the global mean at a weight proportional to the procedure
 * population (see `projectWeight`) so schema debt genuinely moves the grade.
 * Because this single score saturates at 0, `compareToBaseline` also diffs
 * `checks.length` — otherwise new schema errors would be free once the bucket
 * bottoms out.
 */
interface ProjectScore {
    /** Rules that fired at project level, sorted by `name`. */
    checks: CheckResult[];
    /** 0–100, same formula as a procedure. */
    score: number;
}

/** Coverage tallies for the summary line and the Studio matrix header. */
interface MapSummary {
    /** Procedures with no lint firing. */
    clean: number;
    /** Procedures excluded from scoring. */
    exempt: number;
    /** Procedures scoring below the failing floor. */
    failing: number;
    /** Total procedures in the map, exempt included. */
    procedures: number;
    /** Findings attributed to a scored row, after per-rule deduplication. */
    rulesFired: number;
    /** Procedures scoring at or above the failing floor, but not clean. */
    warned: number;
}

/**
 * The `lunora.advisor.map.json` artifact — the unit a baseline is diffed
 * against and the Studio health panel renders.
 */
interface AdvisorMap {
    /**
     * ISO-8601 stamp. Defaults to the current time; pass
     * `ScoreAdvisorOptions.generatedAt` explicitly when the artifact must be
     * byte-stable (tests, reproducible builds) — everything else in the map is
     * a pure function of the findings.
     */
    generatedAt: string;
    /** Band for {@link AdvisorMap.score}. */
    grade: Grade;
    /** Per-procedure rows, sorted by `id` for a stable diff. */
    procedures: ProcedureScore[];
    /** Findings not attributable to a procedure. */
    project: ProjectScore;
    /** Weighted mean over non-exempt procedures plus the project entry, 0–100. */
    score: number;
    /** Coverage tallies. */
    summary: MapSummary;
    /** Artifact shape version; bump on a breaking change so an old baseline is rejected rather than mis-read. */
    version: number;
}

export type { AdvisorMap, CheckResult, Coverage, Grade, MapSummary, ProcedureScore, ProjectScore, Sensitivity, SensitivityLevel, WeightedEntry };
