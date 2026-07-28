/**
 * Where to land after a successful sign-in, when something sent the user there
 * on purpose.
 *
 * `invitations.ts` bounces a signed-out invitee through the sign-in screen with
 * `?redirectTo=&lt;the invitation>`, and an app's own route guard usually does the
 * same. Without this the parameter is written and never read, so the user signs
 * in and lands on the generic post-login page with the invitation forgotten —
 * the bounce looks like it worked and quietly didn't.
 *
 * # Why this validates rather than trusting the URL
 *
 * `redirectTo` comes from the query string, which means it comes from whoever
 * sent the link. Following it blindly is an open redirect: a phishing page mails
 * `…/sign-in?redirectTo=https://evil.example`, the victim signs in on the real
 * site, and gets handed to the attacker with the sign-in looking legitimate. So
 * only same-origin **paths** are honoured, and anything else falls back to the
 * configured destination.
 */

/**
 * Control characters, which can smuggle a value (a newline, a tab) past a naive
 * check further upstream. Hoisted so it compiles once, not per call.
 */
// eslint-disable-next-line no-control-regex -- detecting control characters is precisely the point.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Whether `target` is a safe same-origin path.
 *
 * Deliberately strict — a path, not a URL. Rejected: absolute URLs (any scheme,
 * including a same-origin one, because `javascript:` and `data:` are also
 * absolute), protocol-relative `//evil.example` (a browser reads that as a host,
 * not a path), and backslash variants that some parsers normalise to slashes.
 */
const isSafeRedirect = (target: string): boolean => {
    const trimmed = target.trim();

    if (trimmed === "" || !trimmed.startsWith("/")) {
        return false;
    }

    // `//host` and `/\host` are both host-relative to a browser, not path-relative.
    if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
        return false;
    }

    return !CONTROL_CHARACTERS.test(trimmed);
};

/** Read `redirectTo` off the current URL, or undefined off the browser. */
const readRedirectTo = (parameter = "redirectTo"): string | undefined => {
    const search = (globalThis as { location?: { search?: string } }).location?.search;

    if (search === undefined || search === "") {
        return undefined;
    }

    const value = new URLSearchParams(search).get(parameter);

    return value === null || !isSafeRedirect(value) ? undefined : value.trim();
};

/**
 * The post-sign-in destination: an explicit, validated `redirectTo` when there
 * is one, else the configured default.
 */
const resolveAfterSignIn = (fallback: string): string => readRedirectTo() ?? fallback;

/**
 * Carry `redirectTo` onto an intermediate step's URL.
 *
 * Sign-in can hand off to a second factor before it finishes, and that hop is a
 * fresh page: whatever the original link asked for lives in *this* page's query
 * string and is gone once we navigate. Without this the invitation bounce —
 * the reason this module exists — works for users without 2FA and silently
 * fails for users with it.
 */
const withRedirectTo = (path: string): string => {
    const target = readRedirectTo();

    if (target === undefined) {
        return path;
    }

    // Preserve any query string the app already configured on the step's route.
    const separator = path.includes("?") ? "&" : "?";

    return `${path}${separator}redirectTo=${encodeURIComponent(target)}`;
};

export { isSafeRedirect, readRedirectTo, resolveAfterSignIn, withRedirectTo };
