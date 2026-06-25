/**
 * Branding for the Vite plugin's console output. The plugin pipes through Vite's
 * own logger (which owns timestamps/clearing), so rather than swap the reporter
 * the way the CLI does, we prefix Lunora's lines with the same painted ` lunora `
 * badge from `@lunora/config` — replacing the old plain `[lunora]` text tag — so
 * the dev server and the CLI read as one tool.
 */
import { BADGES, paintBadge } from "@lunora/config";

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

export { advisoryLine, LUNORA_TAG, lunoraLine };
