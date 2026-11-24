/**
 * `advisor.accept` in `lunora.config.*`: advisor findings the project has
 * reviewed and accepted as by design, each named by the rule, the file and the
 * subject it fires on: an export, a table, or a shared helper.
 *
 * An accepted finding carries its reason in the detail and is reported as INFO,
 * so an accepted ERROR stops failing `lunora codegen`, `deploy` and `vite build`,
 * and an accepted WARN stops reading as an open item; both stay in the report.
 * Every entry is exact: it matches one rule in one file for one export (and one
 * table, once a procedure has the finding for several) at the level the
 * reviewer saw, never a rule in general. The level is part of the
 * match, so an acceptance written for an INFO or WARN cannot silently cover the
 * same export after it becomes an ERROR. An entry that matches no finding is a
 * WARN, so an acceptance that no longer applies cannot linger unnoticed.
 */
import type { Finding, Level } from "@lunora/advisor";

/**
 * The subject a finding fires on: the export it is in, the table a schema finding is about, or the helper a call-site
 * finding sits in. Only one of them is set on a given finding, so the entry names whichever the finding carries.
 */
const subjectOf = (advisory: Finding): unknown => advisory.metadata["exportName"] ?? advisory.metadata["table"] ?? advisory.metadata["helper"];

/** The table a procedure's finding is about, when the finding names both. */
const procedureTableOf = (advisory: Finding): unknown => (advisory.metadata["exportName"] === undefined ? undefined : advisory.metadata["table"]);

const namesFinding = (candidate: AcceptedFinding, advisory: Finding): boolean =>
    candidate.rule === advisory.name &&
    candidate.level === advisory.level &&
    candidate.file === advisory.metadata["file"] &&
    candidate.exportName === subjectOf(advisory);

/**
 * Whether the entry's `table` fits the finding. One procedure can carry the same finding for several tables (an RLS
 * gap, an unmasked PII column), so an entry that names no table covers a procedure's table findings only while they
 * are all about one table: once a second table shows up, the entry matches none of them, and the unused-entry WARN
 * asks for the table. A table the procedure starts reaching later is never accepted unseen. Several findings about one
 * table (one per hashed column) still count as one table. A shape's finding names its one table, so an entry for it
 * keeps matching without one.
 */
const tableFits = (candidate: AcceptedFinding, advisory: Finding, advisories: ReadonlyArray<Finding>): boolean => {
    const table = procedureTableOf(advisory);

    if (candidate.table !== undefined || table === undefined) {
        return candidate.table === table;
    }

    return new Set(advisories.filter((other) => namesFinding(candidate, other)).map((other) => procedureTableOf(other))).size === 1;
};

/** One reviewed finding to accept. `reason` says why it is by design; it is shown with the finding. */
interface AcceptedFinding {
    /** The export, table or helper the finding fires on, as the finding names it. */
    exportName: string;
    file: string;
    /** The level the reviewer saw. The entry matches only a finding at this level. */
    level: Level;
    reason: string;
    rule: string;
    /** The table, for a finding that names both a procedure and a table. Needed once the procedure has that finding for more than one table. */
    table?: string;
}

const subjectLabel = (entry: AcceptedFinding): string =>
    entry.table === undefined ? `\`${entry.exportName}\`` : `\`${entry.exportName}\` on table \`${entry.table}\``;

/** The WARN for an entry that matched no finding. */
const staleAcceptance = (entry: AcceptedFinding): Finding => {
    return {
        cacheKey: `advisor_accept_unused:${entry.rule}:${entry.level}:${entry.file}:${entry.exportName}${entry.table === undefined ? "" : `:${entry.table}`}`,
        categories: ["SCHEMA"],
        description: "`advisor.accept` in `lunora.config.*` accepts a finding the advisor does not report.",
        detail: `No ${entry.level} \`${entry.rule}\` in \`${entry.file}\` for ${subjectLabel(entry)} — the acceptance no longer applies.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName: entry.exportName, file: entry.file, rule: entry.rule, ...(entry.table === undefined ? {} : { table: entry.table }) },
        name: "advisor_accept_unused",
        remediation:
            "Remove the entry, or correct the rule, file and export name it names. When a procedure has the finding for more than one table, name the table with `table`.",
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
        const entry = accepted.find((candidate) => namesFinding(candidate, advisory) && tableFits(candidate, advisory, advisories));

        if (entry === undefined) {
            return advisory;
        }

        matched.add(entry);

        return {
            ...advisory,
            detail: `Accepted: ${entry.reason}. ${advisory.detail}`,
            level: "INFO",
            metadata: { ...advisory.metadata, accepted: entry.reason, acceptedFrom: advisory.level },
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
        detail: "`advisor.accept` is not an array of literal `{ rule, file, exportName, level, reason, table? }` objects with non-empty strings, so codegen ignored all of it and every finding keeps its level.",
        facing: "INTERNAL",
        level: "WARN",
        metadata: {},
        name: "advisor_accept_invalid",
        remediation:
            'Write `advisor: { accept: [{ rule: "owner_field_from_args_not_auth", file: "lunora/auth/team.ts", exportName: "addTeamMember", level: "error", reason: "…" }] }` as literals on the config\'s default export.',
        title: "`advisor.accept` is not a list codegen can read, so no acceptance applies",
    };
};

/**
 * Whether the `minSeverity` floor must keep a finding whatever its level: a reviewed ERROR, which stays visible as the
 * finding it was, or a warning about the `accept` list itself. A reviewed WARN or INFO is not kept this way, so an
 * acceptance cannot bring back a finding the floor hides.
 */
const isAcceptanceOutcome = (advisory: Finding): boolean =>
    advisory.metadata["acceptedFrom"] === "ERROR" || advisory.name === "advisor_accept_unused" || advisory.name === "advisor_accept_invalid";

export { applyAcceptedFindings, isAcceptanceOutcome, unreadableAcceptance };
export type { AcceptedFinding };
