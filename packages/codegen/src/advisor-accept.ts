/**
 * `advisor.accept` in `lunora.config.*`: advisor findings the project has
 * reviewed and accepted as by design, each named by the rule, the file and the
 * export it fires on.
 *
 * An accepted finding carries its reason in the detail and is reported as INFO,
 * so an accepted ERROR stops failing `lunora codegen`, `deploy` and `vite build`,
 * and an accepted WARN stops reading as an open item; both stay in the report.
 * Every entry is exact: it matches one rule in one file for one export at the
 * level the reviewer saw, never a rule in general. The level is part of the
 * match, so an acceptance written for an INFO or WARN cannot silently cover the
 * same export after it becomes an ERROR. An entry that matches no finding is a
 * WARN, so an acceptance that no longer applies cannot linger unnoticed.
 */
import type { Finding, Level } from "@lunora/advisor";

/** One reviewed finding to accept. `reason` says why it is by design; it is shown with the finding. */
interface AcceptedFinding {
    exportName: string;
    file: string;
    /** The level the reviewer saw. The entry matches only a finding at this level. */
    level: Level;
    reason: string;
    rule: string;
}

/** The WARN for an entry that matched no ERROR. */
const staleAcceptance = (entry: AcceptedFinding): Finding => {
    return {
        cacheKey: `advisor_accept_unused:${entry.rule}:${entry.level}:${entry.file}:${entry.exportName}`,
        categories: ["SCHEMA"],
        description: "`advisor.accept` in `lunora.config.*` accepts a finding the advisor does not report.",
        detail: `No ${entry.level} \`${entry.rule}\` in \`${entry.file}\` for \`${entry.exportName}\` — the acceptance no longer applies.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName: entry.exportName, file: entry.file, rule: entry.rule },
        name: "advisor_accept_unused",
        remediation: "Remove the entry, or correct the rule, file and export name it names.",
        title: "An accepted advisor finding matches no finding",
    };
};

/**
 * `advisories` with each finding that an entry names demoted to INFO, its reason
 * prefixed to the detail, plus a WARN for every entry that matched nothing.
 */
const applyAcceptedFindings = (advisories: ReadonlyArray<Finding>, accepted: ReadonlyArray<AcceptedFinding>): Finding[] => {
    const matched = new Set<AcceptedFinding>();
    const reviewed = advisories.map((advisory): Finding => {
        const entry = accepted.find(
            (candidate) =>
                candidate.rule === advisory.name &&
                candidate.level === advisory.level &&
                candidate.file === advisory.metadata["file"] &&
                candidate.exportName === advisory.metadata["exportName"],
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

    return [...reviewed, ...accepted.filter((entry) => !matched.has(entry)).map((entry) => staleAcceptance(entry))];
};

/** The WARN for an `accept` list codegen cannot read. Its entries are ignored, so every finding keeps its level. */
const unreadableAcceptance = (): Finding => {
    return {
        cacheKey: "advisor_accept_invalid",
        categories: ["SCHEMA"],
        description: "`advisor.accept` in `lunora.config.*` is read by parsing the file, so every entry must be a literal.",
        detail: "`advisor.accept` is not an array of literal `{ rule, file, exportName, level, reason }` objects with non-empty strings, so codegen ignored all of it and every finding keeps its level.",
        facing: "INTERNAL",
        level: "WARN",
        metadata: {},
        name: "advisor_accept_invalid",
        remediation:
            'Write `advisor: { accept: [{ rule: "owner_field_from_args_not_auth", file: "lunora/auth/team.ts", exportName: "addTeamMember", level: "error", reason: "…" }] }` as literals on the config\'s default export.',
        title: "`advisor.accept` is not a list codegen can read, so no acceptance applies",
    };
};

/** Whether a finding is an acceptance outcome: a reviewed finding demoted to INFO, or a warning about the `accept` list itself. The floor never drops these. */
const isAcceptanceOutcome = (advisory: Finding): boolean =>
    advisory.metadata["accepted"] !== undefined || advisory.name === "advisor_accept_unused" || advisory.name === "advisor_accept_invalid";

export { applyAcceptedFindings, isAcceptanceOutcome, unreadableAcceptance };
export type { AcceptedFinding };
