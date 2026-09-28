/**
 * Branding for a bundler plugin's console output.
 *
 * A plugin pipes through its host's own logger (which owns timestamps and
 * clearing), so rather than swap the reporter the way the CLI does, it prefixes
 * Lunora's lines with the same painted ` lunora ` badge the CLI reporter paints —
 * so the dev server and the CLI read as one tool.
 *
 * Lives here rather than in one plugin package because every bundler adapter
 * (`@lunora/vite`, `@lunora/rspack`) needs the identical badge; a per-plugin copy
 * is how two tools that are meant to look like one drift apart.
 */
import type { CodegenResult } from "@lunora/codegen";
import { describeErrorLevelFindings, sortedUniqueNames } from "@lunora/codegen";

import { BADGES, paintBadge } from "./tui-theme";

/** The painted ` lunora ` badge, prepended to the plugin's branded log lines. */
const LUNORA_TAG: string = paintBadge(BADGES.lunora);

/** Prefix a message with the Lunora badge (e.g. `lunoraLine("codegen done")`). */
const lunoraLine = (message: string): string => `${LUNORA_TAG} ${message}`;

/** A schema-advisory severity (the advisor's `Finding.level`) → the level badge that paints it. */
const ADVISORY_BADGE = { ERROR: BADGES.error, INFO: BADGES.info, WARN: BADGES.warn } as const;

/**
 * A branded schema-advisory line: the level-coloured badge (`warn`/`error`/`info`)
 * — same badges the CLI reporter uses, so the dev server reads as one tool — then
 * the rule name, the detail, and the remediation. Replaces the old dense
 * `lunora-badge … schema advisory [WARN] …` line with the level-appropriate badge.
 */
const advisoryLine = (level: "ERROR" | "INFO" | "WARN", name: string, detail: string, remediation: string): string =>
    `${paintBadge(ADVISORY_BADGE[level])} ${name}: ${detail} — ${remediation}`;

/** The three channels a bundler plugin reports through; `console` satisfies it, as does Rspack's `Logger`. */
interface FindingLogger {
    error: (message: string) => void;
    warn: (message: string) => void;
}

/**
 * Print every schema advisory and platform-portability diagnostic a codegen run
 * produced, each on its own level-appropriate channel.
 *
 * Codegen returns these without printing — each caller presents them through its
 * own channel. Both bundler plugins present them identically, so this is that one
 * presentation: severity → logger method, rendered by {@link advisoryLine}. It
 * lives here rather than in either plugin because the loops were copied verbatim
 * between them, and a copy is how `vite build` and `rspack build` start
 * disagreeing about what a schema problem looks like.
 *
 * Reporting only — {@link blockingFindingsMessage} decides what BLOCKS.
 */
const reportCodegenFindings = (result: Pick<CodegenResult, "advisories" | "platformDiagnostics">, logger: FindingLogger): void => {
    for (const advisory of result.advisories) {
        const line = advisoryLine(advisory.level, advisory.name, advisory.detail, advisory.remediation);

        if (advisory.level === "ERROR") {
            logger.error(line);
        } else {
            logger.warn(line);
        }
    }

    for (const diagnostic of result.platformDiagnostics) {
        const line = advisoryLine(diagnostic.level === "error" ? "ERROR" : "WARN", diagnostic.name, diagnostic.message, diagnostic.remediation);

        if (diagnostic.level === "error") {
            logger.error(line);
        } else {
            logger.warn(line);
        }
    }
};

/**
 * The one aggregated line a bundler plugin fails a production build with, or
 * `undefined` when nothing is ERROR-level.
 *
 * An ERROR advisory says a call throws at runtime; an `error` platform
 * diagnostic says the emitted surface does not match the declared target. Both
 * are wrong output, not style, so `vite build` / `rspack build` / `lunora deploy`
 * all refuse them.
 *
 * The filter+dedup+sort behind it stays in `@lunora/codegen` (shared with the CLI
 * gates); only the wording and the fold of the two categories live here, which is
 * presentation — and presentation is what this module owns, which is also why
 * this needs no `tag` parameter: {@link LUNORA_TAG} is right above it.
 */
const blockingFindingsMessage = (result: Pick<CodegenResult, "advisories" | "platformDiagnostics">): string | undefined => {
    const { advisoryNames, platformDiagnosticNames } = describeErrorLevelFindings(result);
    const blockingNames = sortedUniqueNames([...advisoryNames, ...platformDiagnosticNames]);

    if (blockingNames.length === 0) {
        return undefined;
    }

    const noun = blockingNames.length === 1 ? "advisory/platform diagnostic" : "advisories/platform diagnostics";

    return `${LUNORA_TAG} ${String(blockingNames.length)} ERROR-level ${noun} (${blockingNames.join(", ")}) — see the log above for detail.`;
};

export type { FindingLogger };
export { advisoryLine, blockingFindingsMessage, LUNORA_TAG, lunoraLine, reportCodegenFindings };
