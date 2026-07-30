import type { Level } from "../types";

/**
 * Letter band for a 0–100 score. Thresholds mirror `evlog map`'s
 * `gradeFromScore` so the two tools' grades read the same way.
 */
export type Grade = "at-risk" | "excellent" | "good" | "needs-work";

/**
 * How well a single procedure is covered by the lints that apply to it.
 *
 * Named after `evlog map`'s route verdicts so the artifact stays comparable.
 * `instrumented` means "no lint fired" — every check that applies to this
 * procedure passed; it does not assert that the procedure emits telemetry until
 * the observability lint family lands (see `docs/observability-map.md`, phase 2).
 * `exempt` rows are excluded from the global mean entirely.
 */
export type Coverage = "dark" | "exempt" | "instrumented" | "partial";

/** One lint that fired against a procedure, reduced to its score contribution. */
export interface CheckResult {
    /** Severity of the finding that produced this check. */
    level: Level;
    /** The lint id that fired, e.g. `unindexed_foreign_key`. */
    name: string;
    /** Points subtracted from the procedure's score. */
    weight: number;
}

/** A procedure (the Lunora analog of an `evlog map` route) and its score. */
export interface ProcedureScore {
    /** Lints that fired against this procedure, sorted by `name`. */
    checks: CheckResult[];
    /** Coverage verdict derived from {@link ProcedureScore.score}. */
    coverage: Coverage;
    /** Exported binding name, e.g. `sendMessage`. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** Stable `file#exportName` identity — the baseline diff key. */
    id: string;
    /** Registration kind. */
    kind: "action" | "mutation" | "query";
    /** 0–100, starting at 100 less each check's weight. */
    score: number;
    /** Public (client-callable) or internal (server-called). */
    visibility: "internal" | "public";
    /** This row's weight in the global mean — see `procedureWeight`. */
    weight: number;
}

/**
 * Findings that name no procedure — schema-shape and project-wide lints
 * (missing index, circular FK, plaintext wrangler secret). Folded into the
 * global mean as a single weight-1 entry so schema debt still moves the grade.
 */
export interface ProjectScore {
    /** Lints that fired at project/schema level, sorted by `name`. */
    checks: CheckResult[];
    /** 0–100, same formula as a procedure. */
    score: number;
}

/** Coverage tallies for the summary line and the Studio matrix header. */
export interface MapSummary {
    /** Procedures scoring below the partial floor. */
    dark: number;
    /** Procedures excluded from scoring. */
    exempt: number;
    /** Total findings scored, procedure and project alike. */
    findings: number;
    /** Procedures with no lint firing. */
    instrumented: number;
    /** Procedures scoring at or above the partial floor, but not clean. */
    partial: number;
    /** Total procedures in the map, exempt included. */
    procedures: number;
}

/**
 * The `lunora.advisor.map.json` artifact — the unit a baseline is diffed
 * against and the Studio health panel renders.
 */
export interface AdvisorMap {
    /** ISO-8601 stamp supplied by the caller (never read from the clock here, so the map stays deterministic). */
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
