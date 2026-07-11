/**
 * Pure alert-evaluation helpers for the Observability "watches while you sleep"
 * tier. Kept out of the `lunora/telemetry.ts` mutation (which does the DB writes)
 * so the firing decision + notification rendering are unit-testable, mirroring
 * how `usage.ingest` delegates to the pure `evaluateSpendCap`.
 */

/** What a rule watches. */
export type AlertTarget = "incident" | "issue";

/** The source (issue/incident) a rule is evaluated against, for rendering. */
export interface AlertSource {
    count: number;
    culprit: string;
    sampleMessage: string;
    title: string;
}

/**
 * A rule fires the first time a source's count reaches the threshold — i.e. the
 * count crossed it on this ingest (`before < threshold &lt;= after`). Because a
 * source's count only grows, this fires exactly once per rule, never repeatedly.
 */
export const crossesThreshold = (before: number, after: number, threshold: number): boolean => before < threshold && after >= threshold;

/** Render a fired alert's subject + body from the rule and the tripping source. */
export const renderAlert = (rule: { name: string; target: AlertTarget }, source: AlertSource): { body: string; subject: string } => {
    return {
        body:
            `${rule.target === "incident" ? "Incident" : "Issue"} "${source.title}" (${source.culprit}) reached ` +
            `${String(source.count)} events on Lunora Cloud.\n\nSample: ${source.sampleMessage}`,
        subject: `[Lunora] ${rule.name}: ${source.title}`,
    };
};
