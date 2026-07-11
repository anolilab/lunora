/**
 * Pure prompt construction for the AI incident-triage action
 * (`incidents.triage`). Kept out of the action so the prompt is unit-testable
 * (the `@lunora/ai` `generateText` call itself is not) and deterministic.
 */

/** The incident being triaged, reduced to what the prompt needs. */
export interface TriageIncident {
    container?: string;
    count: number;
    kind: "crash_loop" | "error_spike" | "oom";
    title: string;
}

/** A related error group folded onto the incident's fingerprint. */
export interface TriageIssue {
    count: number;
    culprit: string;
    sampleMessage: string;
    title: string;
}

/** Cap the related errors fed to the model so the prompt stays bounded. */
const MAX_ISSUES = 10;

/**
 * Build the triage prompt from an incident and its related error groups. Asks
 * for a terse root-cause summary + the single highest-impact next step.
 */
export const buildTriagePrompt = (incident: TriageIncident, issues: ReadonlyArray<TriageIssue>): string => {
    const errorLines = issues
        .slice(0, MAX_ISSUES)
        .map((issue, index) => `${String(index + 1)}. ${issue.culprit} (${String(issue.count)}×): ${issue.sampleMessage}`);

    return [
        "You are an SRE assistant triaging a Lunora Cloud incident. Be concrete and terse.",
        "",
        `Incident: ${incident.title}`,
        `Kind: ${incident.kind}${incident.container === undefined ? "" : ` (container: ${incident.container})`}`,
        `Occurrences: ${String(incident.count)}`,
        "",
        "Related errors:",
        ...(errorLines.length > 0 ? errorLines : ["(none captured)"]),
        "",
        "In 3-5 sentences, summarize the likely root cause and the single highest-impact next step.",
    ].join("\n");
};
