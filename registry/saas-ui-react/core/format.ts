/**
 * Presentation helpers. Pure by construction: every one takes the clock, and
 * the time zone a calendar day is read in, as arguments rather than reading
 * `Date.now()` or the host's zone, so a test asserts a string instead of a
 * moving target, and a server render and the client hydration that follows it
 * agree. The zone defaults to UTC; a view passes the viewer's.
 */

const WHITESPACE = /\s+/u;
/** Runs of `_`/`-` in an identifier, read as spaces when it is shown to a person. */
const SEPARATORS = /[_-]+/gu;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One formatter per zone: building an `Intl.DateTimeFormat` costs far more than formatting with one, and a feed formats every row. */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The `YYYY-MM-DD` a timestamp falls in, in `timeZone` (an IANA name) — the
 * grouping key for a feed. An event at 23:30 in Berlin belongs to that evening
 * for a Berlin viewer, not to the next UTC day.
 */
const dayKey = (timestamp: number, timeZone = "UTC"): string => {
    let formatter = dayFormatters.get(timeZone);

    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" });
        dayFormatters.set(timeZone, formatter);
    }

    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));

    return `${String(parts["year"])}-${String(parts["month"])}-${String(parts["day"])}`;
};

/** Elapsed time in words — "just now", "4m ago", "3h ago", "2d ago" — then the date in `timeZone`. */
const relativeTime = (timestamp: number, now: number, timeZone?: string): string => {
    const elapsed = Math.max(0, now - timestamp);

    if (elapsed < MINUTE) {
        return "just now";
    }

    if (elapsed < HOUR) {
        return `${Math.floor(elapsed / MINUTE).toString()}m ago`;
    }

    if (elapsed < DAY) {
        return `${Math.floor(elapsed / HOUR).toString()}h ago`;
    }

    if (elapsed < 7 * DAY) {
        return `${Math.floor(elapsed / DAY).toString()}d ago`;
    }

    return dayKey(timestamp, timeZone);
};

/** Up to two initials for an avatar fallback. Never more: three stops reading as initials. */
const initials = (name: string): string =>
    name
        .split(WHITESPACE)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");

/** Title-case a plan id for display (`pro` → `Pro`, `team_annual` → `Team annual`). */
const planLabel = (plan: string): string => {
    const spaced = plan.replaceAll(SEPARATORS, " ").trim();

    return spaced === "" ? "Free" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export { dayKey, initials, planLabel, relativeTime, SEPARATORS };
