/**
 * Display formatters for the hosted studio.
 *
 * The date/number helpers below pin an explicit locale and timezone, which matters
 * now that sections render from server-preloaded data. A bare `toLocaleString()`
 * resolves against the ambient locale and timezone of whichever side is running:
 * workerd formats as `en-US`/UTC, the browser as the visitor's. React 19 sees the
 * two strings disagree, logs a hydration error and repaints — a visible flicker on
 * the most-visited tabs. (`react-doctor`'s `no-locale-format-in-render` flags it.)
 *
 * Pinning both makes the two sides agree, and UTC is the honest choice for a
 * control plane: every timestamp it stores is epoch-ms from `ctx.now`, so an
 * operator reading audit or session data gets one unambiguous clock rather than
 * whatever their browser is set to. The suffix says so on the wider formats.
 */

const LOCALE = "en-GB";
const TIME_ZONE = "UTC";

/** Duration as a compact `12ms` / `1.4s`. */
export const formatMs = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Date + time in UTC, e.g. `28 Jul 2026, 14:03:11 UTC`. */
export const formatDateTime = (epochMs: number): string =>
    `${new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "medium", timeZone: TIME_ZONE }).format(new Date(epochMs))} UTC`;

/** Time of day in UTC, e.g. `14:03:11` — for dense per-row timestamps. */
export const formatTime = (epochMs: number): string => new Intl.DateTimeFormat(LOCALE, { timeStyle: "medium", timeZone: TIME_ZONE }).format(new Date(epochMs));

/** Date in UTC, e.g. `28 Jul 2026` — for axis labels. */
export const formatDate = (epochMs: number): string => new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeZone: TIME_ZONE }).format(new Date(epochMs));

/** Thousands-separated integer, e.g. `1,234,567`. */
export const formatNumber = (value: number): string => new Intl.NumberFormat(LOCALE).format(value);
