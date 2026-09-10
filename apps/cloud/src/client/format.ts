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

/*
 * Built once, at module scope. An `Intl` formatter compiles its locale data on
 * construction, and these run per ROW of the logs, traces and metrics tables —
 * constructing them inside the function turned every cell into a locale-table
 * build. Safe at module scope, unlike the `Intl.DisplayNames` below: a fixed
 * locale plus a fixed time zone is present on every runtime that has `Intl` at
 * all, so there is no constructor throw to defer.
 */
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "medium", timeZone: TIME_ZONE });
const TIME_FORMAT = new Intl.DateTimeFormat(LOCALE, { timeStyle: "medium", timeZone: TIME_ZONE });
const DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeZone: TIME_ZONE });
const NUMBER_FORMAT = new Intl.NumberFormat(LOCALE);

/** Duration as a compact `12ms` / `1.4s`. */
export const formatMs = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Date + time in UTC, e.g. `28 Jul 2026, 14:03:11 UTC`. */
export const formatDateTime = (epochMs: number): string => `${DATE_TIME_FORMAT.format(new Date(epochMs))} UTC`;

/** Time of day in UTC, e.g. `14:03:11` — for dense per-row timestamps. */
export const formatTime = (epochMs: number): string => TIME_FORMAT.format(new Date(epochMs));

/** Date in UTC, e.g. `28 Jul 2026` — for axis labels. */
export const formatDate = (epochMs: number): string => DATE_FORMAT.format(new Date(epochMs));

/** Thousands-separated integer, e.g. `1,234,567`. */
export const formatNumber = (value: number): string => NUMBER_FORMAT.format(value);

/** ASCII code point of `A`, the base for the regional-indicator offset below. */
const LETTER_A = 65;

/** First regional-indicator symbol (🇦) — flag emoji are two of these, one per ISO letter. */
const REGIONAL_INDICATOR_A = 0x1_f1_e6;

/** An ISO-3166 alpha-2 code. Anything else (`unknown`, an unresolved value) is not a country. */
const ISO_ALPHA_2 = /^[a-z]{2}$/iu;

/**
 * Flag emoji for an ISO-3166 alpha-2 country code, or an empty string when the
 * code is not two letters (`unknown`, or a value Cloudflare could not resolve).
 *
 * Derived from the code rather than looked up: a regional-indicator pair IS the
 * flag, so this needs no asset, no sprite sheet, and no per-country data to fall
 * out of date.
 */
export const countryFlag = (code: string): string => {
    if (!ISO_ALPHA_2.test(code)) {
        return "";
    }

    // Exactly two ASCII letters by the guard above, so the pair is indexed
    // directly rather than spread — a string spread would be a claim about
    // multi-code-point input this function has already ruled out.
    const upper = code.toUpperCase();

    return String.fromCodePoint(
        REGIONAL_INDICATOR_A + (upper.codePointAt(0) ?? LETTER_A) - LETTER_A,
        REGIONAL_INDICATOR_A + (upper.codePointAt(1) ?? LETTER_A) - LETTER_A,
    );
};

/**
 * The shared region formatter, built once.
 *
 * `new Intl.DisplayNames(...)` rebuilds its locale data on every construction,
 * and this is called once per row of the country breakdown — so constructing it
 * inside the function turned a lookup into a per-row locale-table build.
 *
 * Lazily memoised rather than built at module scope: the constructor throws on a
 * runtime without the region table, and a module-level throw would take down the
 * whole chunk rather than degrading one column to raw country codes.
 */
let cachedRegionNames: Intl.DisplayNames | null | undefined;

const regionNames = (): Intl.DisplayNames | null => {
    cachedRegionNames ??= (() => {
        try {
            // react-doctor-disable-next-line react-doctor/js-hoist-intl -- built once, but LAZILY on purpose: `Intl.DisplayNames` throws on a runtime without the region table, and a module-scope throw would take down the whole chunk instead of degrading one column to raw country codes.
            return new Intl.DisplayNames(undefined, { type: "region" });
        } catch {
            return null;
        }
    })();

    return cachedRegionNames;
};

/**
 * Human country name for an ISO code, falling back to the code itself.
 *
 * `Intl.DisplayNames` is the platform's own localized region table — shipping a
 * country-name map alongside it would be a second, staler copy of data the
 * runtime already has, in every language it already has it in.
 */
export const countryName = (code: string): string => {
    if (!ISO_ALPHA_2.test(code)) {
        return code === "" ? "Unknown" : code;
    }

    try {
        return regionNames()?.of(code.toUpperCase()) ?? code;
    } catch {
        // A runtime without the region table — show the code rather than nothing.
        return code;
    }
};
