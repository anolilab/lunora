import type { AdvisorProcedureProtection } from "../procedure-protections";
import type { Finding, Lint, LintContext } from "../types";
import { coverageFromScore, gradeFromScore, procedureWeight, projectWeight, scoreGlobal, scoreProcedure, weightFor, worstLevel } from "./score";
import type { AdvisorMap, CheckResult, Coverage, MapSummary, ProcedureScore, ProjectScore } from "./types";

/**
 * Codepoint ordering. `localeCompare` would sort by the host's `LANG`/`LC_ALL`,
 * so the same repo scored on a Danish-locale runner emits a different row order
 * than an `en_US` one — the committed artifact would churn and a
 * `git diff --exit-code` gate would fail for no reason. Ordering must be a
 * property of the data, not the machine.
 */
const byCodepoint = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/** Order checks deterministically so a committed baseline diffs cleanly. */
const byName = (a: CheckResult, b: CheckResult): number => byCodepoint(a.name, b.name);

/** Read a string field off a finding's untyped metadata bag. */
const readString = (metadata: Record<string, unknown>, key: string): string | undefined => {
    const value = metadata[key];

    return typeof value === "string" ? value : undefined;
};

/** `file#exportName` — the stable identity shared by procedures and baseline rows. */
const procedureId = (file: string, exportName: string): string => `${file}#${exportName}`;

/**
 * Fold a rule's findings into a single {@link CheckResult}, keeping the worst
 * severity and heaviest weight seen and counting the occurrences.
 */
const foldCheck = (existing: CheckResult | undefined, level: Finding["level"], name: string, weight: number): CheckResult => {
    if (existing === undefined) {
        return { level, name, occurrences: 1, weight };
    }

    return {
        level: worstLevel(existing.level, level),
        name,
        occurrences: existing.occurrences + 1,
        weight: Math.max(existing.weight, weight),
    };
};

/**
 * Route each finding to the procedure it names, or to the project bucket.
 *
 * A finding attaches only to a procedure the feeder actually declared; an
 * unknown `file`/`exportName` pair (or a schema-level finding, which carries
 * neither) is project-wide rather than silently dropped. Note that several
 * procedure-local lints — `filter_without_index` most importantly — emit `file`
 * without `exportName` today, so they land in the project bucket; closing that
 * gap needs an `exportName` on the codegen feeder's query evidence.
 */
const attributeFindings = (
    procedures: ReadonlyArray<AdvisorProcedureProtection>,
    findings: ReadonlyArray<Finding>,
    weightOf: (finding: Finding) => number,
): { byProcedure: Map<string, CheckResult[]>; project: CheckResult[] } => {
    const checksById = new Map<string, Map<string, CheckResult>>();

    for (const procedure of procedures) {
        checksById.set(procedureId(procedure.file, procedure.exportName), new Map());
    }

    const projectChecks = new Map<string, CheckResult>();

    for (const finding of findings) {
        const file = readString(finding.metadata, "file");
        const exportName = readString(finding.metadata, "exportName");
        const owner = file !== undefined && exportName !== undefined ? checksById.get(procedureId(file, exportName)) : undefined;
        const bucket = owner ?? projectChecks;

        bucket.set(finding.name, foldCheck(bucket.get(finding.name), finding.level, finding.name, weightOf(finding)));
    }

    return {
        byProcedure: new Map([...checksById].map(([id, checks]) => [id, [...checks.values()].toSorted(byName)])),
        project: [...projectChecks.values()].toSorted(byName),
    };
};

/** Count each coverage verdict in one pass. */
const summarise = (scored: ReadonlyArray<ProcedureScore>, project: ProjectScore): MapSummary => {
    const tally: Record<Coverage, number> = { clean: 0, exempt: 0, failing: 0, warned: 0 };
    let rulesFired = project.checks.length;

    for (const entry of scored) {
        tally[entry.coverage] += 1;
        rulesFired += entry.checks.length;
    }

    return { clean: tally.clean, exempt: tally.exempt, failing: tally.failing, procedures: scored.length, rulesFired, warned: tally.warned };
};

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
     * ladder. Pass the **same set** `runAdvisor` ran: a lint missing here simply
     * falls back to its severity default, so a mismatched set silently shifts
     * scores rather than erroring.
     */
    lints?: ReadonlyArray<Lint>;
}

/**
 * Roll a lint run up into a scored coverage map (see the package's
 * `docs/index.mdx` for the scoring rules and the baseline gate).
 *
 * Pure: it re-reads the `findings` a caller already got from `runAdvisor` rather
 * than running lints itself, so scoring never double-runs a rule and the lint
 * core stays untouched. Findings are attributed to a procedure via their
 * `metadata.file` + `metadata.exportName`; everything else lands in the project
 * bucket, which is folded into the global mean at a weight proportional to the
 * procedure population so schema debt genuinely moves the grade.
 */
const scoreAdvisor = (context: LintContext, findings: ReadonlyArray<Finding>, options: ScoreAdvisorOptions = {}): AdvisorMap => {
    const declaredWeights = new Map<string, number>();

    for (const lint of options.lints ?? []) {
        if (lint.weight !== undefined) {
            declaredWeights.set(lint.name, lint.weight);
        }
    }

    const exempt = new Set(options.exempt);
    const procedures = context.procedureProtections ?? [];
    const attributed = attributeFindings(procedures, findings, (finding) => weightFor(declaredWeights.get(finding.name), finding.level));

    const scored: ProcedureScore[] = procedures
        .map((procedure) => {
            const id = procedureId(procedure.file, procedure.exportName);
            const checks = attributed.byProcedure.get(id) ?? [];
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
        .toSorted((a, b) => byCodepoint(a.id, b.id));

    const project: ProjectScore = { checks: attributed.project, score: scoreProcedure(attributed.project) };
    const counted = scored.filter((entry) => entry.coverage !== "exempt");
    const totalProcedureWeight = counted.reduce((total, entry) => total + entry.weight, 0);
    const globalScore = scoreGlobal([...counted, { score: project.score, weight: projectWeight(totalProcedureWeight) }]);

    return {
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        grade: gradeFromScore(globalScore),
        procedures: scored,
        project,
        score: globalScore,
        summary: summarise(scored, project),
        version: MAP_VERSION,
    };
};

export { byCodepoint, MAP_VERSION, scoreAdvisor };
export type { ScoreAdvisorOptions };
