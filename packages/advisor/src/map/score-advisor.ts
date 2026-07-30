import type { Finding, Lint, LintContext } from "../types";
import { coverageFromScore, DEFAULT_WEIGHT_BY_LEVEL, gradeFromScore, procedureWeight, PROJECT_WEIGHT, scoreGlobal, scoreProcedure } from "./score";
import type { AdvisorMap, CheckResult, Coverage, ProcedureScore, ProjectScore } from "./types";

/** Read a string field off a finding's untyped metadata bag. */
const readString = (metadata: Record<string, unknown>, key: string): string | undefined => {
    const value = metadata[key];

    return typeof value === "string" ? value : undefined;
};

/** `file#exportName` — the stable identity shared by procedures and baseline rows. */
const procedureId = (file: string, exportName: string): string => `${file}#${exportName}`;

/** Order checks deterministically so a committed baseline diffs cleanly. */
const byName = (a: CheckResult, b: CheckResult): number => a.name.localeCompare(b.name);

/**
 * {@link AdvisorMap.version} this build emits. Bump on a breaking shape change
 * so `compareToBaseline` rejects a stale artifact instead of mis-reading it.
 */
const MAP_VERSION = 1;

/** Options for {@link scoreAdvisor}. */
interface ScoreAdvisorOptions {
    /**
     * Procedure ids (`file#exportName`) to exclude from scoring — the escape
     * hatch for a handler whose findings are knowingly accepted. Exempt rows
     * still appear in the map, marked `exempt`, but pull no weight.
     */
    exempt?: ReadonlyArray<string>;

    /**
     * Stamp written to {@link AdvisorMap.generatedAt}. Defaults to now; pass it
     * explicitly when the map must be byte-stable (tests, reproducible builds).
     */
    generatedAt?: string;

    /**
     * Lints whose explicit {@link Lint.weight} should override the severity
     * ladder. Pass the same set given to `runAdvisor`; lints absent here (or
     * declaring no weight) fall back to `DEFAULT_WEIGHT_BY_LEVEL`.
     */
    lints?: ReadonlyArray<Lint>;
}

/**
 * Roll a lint run up into a scored coverage map — the Lunora analog of
 * `evlog map`'s scan artifact (see `docs/observability-map.md`).
 *
 * Pure: it re-reads the `findings` a caller already got from `runAdvisor` rather
 * than running lints itself, so scoring never double-runs a rule and the lint
 * core stays untouched. Findings are attributed to a procedure via their
 * `metadata.file` + `metadata.exportName`; everything else (schema shape,
 * wrangler config) lands in the project bucket, which is folded into the global
 * mean at weight 1 so schema debt still moves the grade.
 */
const scoreAdvisor = (context: LintContext, findings: ReadonlyArray<Finding>, options: ScoreAdvisorOptions = {}): AdvisorMap => {
    const explicitWeights = new Map<string, number>();

    for (const lint of options.lints ?? []) {
        if (lint.weight !== undefined) {
            explicitWeights.set(lint.name, lint.weight);
        }
    }

    const exempt = new Set(options.exempt);
    const procedures = context.procedureProtections ?? [];
    const checksById = new Map<string, CheckResult[]>();

    for (const procedure of procedures) {
        checksById.set(procedureId(procedure.file, procedure.exportName), []);
    }

    const projectChecks: CheckResult[] = [];

    for (const finding of findings) {
        const check: CheckResult = {
            level: finding.level,
            name: finding.name,
            weight: explicitWeights.get(finding.name) ?? DEFAULT_WEIGHT_BY_LEVEL[finding.level],
        };

        const file = readString(finding.metadata, "file");
        const exportName = readString(finding.metadata, "exportName");
        // A finding only attaches to a procedure the feeder actually declared;
        // an unknown file/export pair (or a schema-level finding, which carries
        // neither) is project-wide rather than silently dropped.
        const owner = file !== undefined && exportName !== undefined ? checksById.get(procedureId(file, exportName)) : undefined;

        (owner ?? projectChecks).push(check);
    }

    const scored: ProcedureScore[] = procedures
        .map((procedure) => {
            const id = procedureId(procedure.file, procedure.exportName);
            const checks = (checksById.get(id) ?? []).toSorted(byName);
            const score = scoreProcedure(checks);
            const isExempt = exempt.has(id);

            return {
                checks,
                coverage: isExempt ? ("exempt" as const) : coverageFromScore(score),
                exportName: procedure.exportName,
                file: procedure.file,
                id,
                kind: procedure.kind,
                score,
                visibility: procedure.visibility,
                weight: isExempt ? 0 : procedureWeight(procedure),
            };
        })
        .toSorted((a, b) => a.id.localeCompare(b.id));

    const project: ProjectScore = { checks: projectChecks.toSorted(byName), score: scoreProcedure(projectChecks) };
    const globalScore = scoreGlobal([...scored.filter((entry) => entry.coverage !== "exempt"), { score: project.score, weight: PROJECT_WEIGHT }]);

    const tally = (coverage: Coverage): number => scored.filter((entry) => entry.coverage === coverage).length;

    return {
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        grade: gradeFromScore(globalScore),
        procedures: scored,
        project,
        score: globalScore,
        summary: {
            dark: tally("dark"),
            exempt: tally("exempt"),
            findings: findings.length,
            instrumented: tally("instrumented"),
            partial: tally("partial"),
            procedures: scored.length,
        },
        version: MAP_VERSION,
    };
};

export { MAP_VERSION, scoreAdvisor };
export type { ScoreAdvisorOptions };
