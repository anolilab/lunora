/**
 * Presentation helpers. Pure and timezone-naive by construction: every one
 * takes the clock as an argument rather than reading `Date.now()`, so a test
 * asserts a string instead of a moving target, and a server render and the
 * client hydration that follows it agree.
 */

const WHITESPACE = /\s+/u;
const SEPARATORS = /[_-]+/gu;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Elapsed time in words — "just now", "4m ago", "3h ago", "2d ago" — then an absolute date. */
const relativeTime = (timestamp: number, now: number): string => {
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

    return new Date(timestamp).toISOString().slice(0, 10);
};

/** The `YYYY-MM-DD` a timestamp falls in — the grouping key for a feed. */
const dayKey = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

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

export { dayKey, initials, planLabel, relativeTime };
