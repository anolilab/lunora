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

export { LUNORA_TAG, lunoraLine };
