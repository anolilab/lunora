/**
 * `advisor.accept` in `lunora.config.*`: ERRORs the project has reviewed and
 * accepted, each named by the rule, the file and the export it fires on.
 *
 * An accepted ERROR is demoted to INFO and carries its reason in the detail, so
 * it stops failing `lunora codegen`, `deploy` and `vite build`, but it stays in
 * the report. Every entry is exact: it matches one rule in one file for one
 * export, never a rule in general, so a new procedure with the same problem is
 * still an ERROR. An entry that matches no ERROR is a WARN, so an acceptance
 * that no longer applies cannot linger unnoticed.
 */
import type { Finding } from "@lunora/advisor";

/** One reviewed ERROR to accept. `reason` says why it is safe; it is shown with the finding. */
interface AcceptedFinding {
    exportName: string;
    file: string;
    reason: string;
    rule: string;
}

/** The WARN for an entry that matched no ERROR. */
const staleAcceptance = (entry: AcceptedFinding): Finding => {
    return {
        cacheKey: `advisor_accept_unused:${entry.rule}:${entry.file}:${entry.exportName}`,
        categories: ["SCHEMA"],
        description: "`advisor.accept` in `lunora.config.*` accepts a finding the advisor does not report as an error.",
        detail: `No ERROR \`${entry.rule}\` in \`${entry.file}\` for \`${entry.exportName}\` — the acceptance no longer applies.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName: entry.exportName, file: entry.file, rule: entry.rule },
        name: "advisor_accept_unused",
        remediation: "Remove the entry, or correct the rule, file and export name it names.",
        title: "An accepted advisor finding matches no error",
    };
};

/**
 * `advisories` with each ERROR that an entry names demoted to INFO, its reason
 * prefixed to the detail, plus a WARN for every entry that matched nothing.
 */
const applyAcceptedFindings = (advisories: ReadonlyArray<Finding>, accepted: ReadonlyArray<AcceptedFinding>): Finding[] => {
    const matched = new Set<AcceptedFinding>();
    const demoted = advisories.map((advisory): Finding => {
        if (advisory.level !== "ERROR") {
            return advisory;
        }

        const entry = accepted.find(
            (candidate) =>
                candidate.rule === advisory.name && candidate.file === advisory.metadata["file"] && candidate.exportName === advisory.metadata["exportName"],
        );

        if (entry === undefined) {
            return advisory;
        }

        matched.add(entry);

        return {
            ...advisory,
            detail: `Accepted: ${entry.reason}. ${advisory.detail}`,
            level: "INFO",
            metadata: { ...advisory.metadata, accepted: entry.reason },
        };
    });

    return [...demoted, ...accepted.filter((entry) => !matched.has(entry)).map((entry) => staleAcceptance(entry))];
};

/** The WARN for an `accept` list codegen cannot read. Its entries are ignored, so every ERROR still fails the gate. */
const unreadableAcceptance = (): Finding => {
    return {
        cacheKey: "advisor_accept_invalid",
        categories: ["SCHEMA"],
        description: "`advisor.accept` in `lunora.config.*` is read by parsing the file, so every entry must be a literal.",
        detail: "`advisor.accept` is not an array of literal `{ rule, file, exportName, reason }` objects with non-empty strings, so codegen ignored all of it and every ERROR still fails the gate.",
        facing: "INTERNAL",
        level: "WARN",
        metadata: {},
        name: "advisor_accept_invalid",
        remediation:
            'Write `advisor: { accept: [{ rule: "owner_field_from_args_not_auth", file: "lunora/auth/team.ts", exportName: "addTeamMember", reason: "…" }] }` as literals on the config\'s default export.',
        title: "`advisor.accept` is not a list codegen can read, so no acceptance applies",
    };
};

/** Whether a finding is an acceptance outcome: a demoted ERROR, or a warning about the `accept` list itself. The floor never drops these. */
const isAcceptanceOutcome = (advisory: Finding): boolean =>
    advisory.metadata["accepted"] !== undefined || advisory.name === "advisor_accept_unused" || advisory.name === "advisor_accept_invalid";

export { applyAcceptedFindings, isAcceptanceOutcome, unreadableAcceptance };
export type { AcceptedFinding };
