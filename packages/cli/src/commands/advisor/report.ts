import type { AdvisorMap, BaselineComparison, Coverage, ProcedureScore } from "@lunora/advisor";
import { byCodepoint } from "@lunora/advisor";

/** Single-character verdict marks, so a wide matrix stays readable. */
const MARK: Readonly<Record<Coverage, string>> = { clean: "·", exempt: "–", failing: "✗", warned: "!" };

/** Pad to a fixed width so columns line up without a table library. */
const pad = (value: string, width: number): string => (value.length >= width ? value : value + " ".repeat(width - value.length));

/** `messages#sendMessage  (public mutation)` */
const describe = (entry: ProcedureScore): string => `${entry.id}  (${entry.visibility} ${entry.kind})`;

/** Longest id in the map, for column alignment. */
const idWidth = (entries: ReadonlyArray<ProcedureScore>): number => {
    let widest = 0;

    for (const entry of entries) {
        widest = Math.max(widest, entry.id.length);
    }

    return widest;
};

/** One `score  mark id` line. */
const row = (entry: ProcedureScore, width: number): string =>
    `  ${pad(String(entry.score), 3)}  ${MARK[entry.coverage]}  ${pad(entry.id, width)}  ${entry.visibility} ${entry.kind}`;

/** The regression lines a gate run should show. */
const comparisonLines = (comparison: BaselineComparison): string[] => {
    if (!comparison.comparable) {
        return [`  baseline not comparable (${comparison.reason}) — regenerate it; this run cannot verify anything`];
    }

    if (!comparison.regressed) {
        return [`  no regression against baseline (score ${comparison.scoreDelta >= 0 ? "+" : ""}${String(comparison.scoreDelta)})`];
    }

    const lines = [`  REGRESSED against baseline (score ${comparison.scoreDelta >= 0 ? "+" : ""}${String(comparison.scoreDelta)})`];

    for (const drop of comparison.dropped) {
        lines.push(`    ${drop.id}: ${String(drop.before)} → ${String(drop.after)}`);
    }

    for (const id of comparison.newFailing) {
        lines.push(`    ${id}: now failing`);
    }

    for (const id of comparison.worsened) {
        lines.push(`    ${id}: more findings than the baseline`);
    }

    if (comparison.projectRegressed) {
        lines.push("    project: new schema/config rules fired");
    }

    return lines;
};

/**
 * The default view: headline score, coverage tallies, and only the procedures
 * that actually have findings — a clean project prints a few lines.
 */
const formatSummary = (map: AdvisorMap, comparison?: BaselineComparison): string => {
    const flagged = map.procedures.filter((entry) => entry.coverage !== "clean" && entry.coverage !== "exempt");
    const width = idWidth(flagged);
    const lines = [
        `advisor health ${String(map.score)}/100 — ${map.grade}`,
        `  ${String(map.summary.clean)} clean · ${String(map.summary.warned)} warned · ${String(map.summary.failing)} failing · ${String(map.summary.exempt)} exempt (${String(map.summary.procedures)} procedures, ${String(map.summary.rulesFired)} rules fired)`,
    ];

    if (map.project.checks.length > 0) {
        lines.push("", `  project ${String(map.project.score)}/100 — ${map.project.checks.map((check) => check.name).join(", ")}`);
    }

    if (flagged.length > 0) {
        lines.push("", ...flagged.map((entry) => row(entry, width)), "", "  run with --all for every procedure, or --entry <file#export> for one");
    }

    if (comparison !== undefined) {
        lines.push("", ...comparisonLines(comparison));
    }

    return lines.join("\n");
};

/** The detail lines under one procedure in the matrix: its exemption, or the rules that fired. */
const detailLines = (entry: ProcedureScore): string[] => {
    if (entry.coverage === "exempt") {
        const reason = entry.exemptReason === undefined || entry.exemptReason === "" ? "no reason given" : entry.exemptReason;

        return [`         exempt: ${reason}`];
    }

    return entry.checks.map((check) => {
        const repeats = check.occurrences > 1 ? `, ×${String(check.occurrences)}` : "";

        return `         ${check.name} (−${String(check.weight)}${repeats})`;
    });
};

/** Group the map's rows by source file. */
const groupByFile = (entries: ReadonlyArray<ProcedureScore>): [string, ProcedureScore[]][] => {
    const byFile = new Map<string, ProcedureScore[]>();

    for (const entry of entries) {
        const bucket = byFile.get(entry.file);

        if (bucket === undefined) {
            byFile.set(entry.file, [entry]);
        } else {
            bucket.push(entry);
        }
    }

    return [...byFile].toSorted(([a], [b]) => byCodepoint(a, b));
};

/** `--all`: every procedure, grouped by file. */
const formatMatrix = (map: AdvisorMap): string => {
    const width = idWidth(map.procedures);
    const lines = [
        `advisor health ${String(map.score)}/100 — ${map.grade}`,
        "",
        `  legend: ${MARK.clean} clean  ${MARK.warned} warned  ${MARK.failing} failing  ${MARK.exempt} exempt`,
    ];

    for (const [file, entries] of groupByFile(map.procedures)) {
        lines.push("", `  ${file}`);

        for (const entry of entries) {
            lines.push(row(entry, width), ...detailLines(entry));
        }
    }

    return lines.join("\n");
};

/** `--entry file#export`: one procedure and every rule that fired on it. */
const formatEntry = (map: AdvisorMap, id: string): string => {
    const entry = map.procedures.find((candidate) => candidate.id === id);

    if (entry === undefined) {
        const known = map.procedures.slice(0, 10).map((candidate) => `    ${candidate.id}`);

        return [`no procedure ${id} in the map. Known ids:`, ...known, map.procedures.length > 10 ? "    …" : ""].filter(Boolean).join("\n");
    }

    const lines = [`${describe(entry)} — ${String(entry.score)}/100, ${entry.coverage}`, `  weight in the global mean: ${String(entry.weight)}`];

    if (entry.checks.length === 0) {
        lines.push("", "  no rule fired");

        return lines.join("\n");
    }

    lines.push("", "  rules fired:");

    for (const check of entry.checks) {
        lines.push(`    [${check.level}] ${check.name} −${String(check.weight)}${check.occurrences > 1 ? ` (×${String(check.occurrences)})` : ""}`);
    }

    return lines.join("\n");
};

export { formatEntry, formatMatrix, formatSummary };
