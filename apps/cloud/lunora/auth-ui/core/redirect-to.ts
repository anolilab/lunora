/**
 * Where to land after a successful sign-in, when something sent the user there
 * on purpose.
 *
 * `invitations.ts` bounces a signed-out invitee through the sign-in screen with
 * `?redirectTo=<the invitation>`, and an app's own route guard usually does the
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

import { queryParameter } from "./browser-location";
import type { ControllerContext } from "./config";

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
    const value = queryParameter(parameter);

    if (value === undefined) {
        return undefined;
    }

    // Validate and return the *same* string, so a reader does not have to open
    // `isSafeRedirect` to confirm it trims identically.
    const trimmed = value.trim();

    return isSafeRedirect(trimmed) ? trimmed : undefined;
};

/**
 * The post-sign-in destination: an explicit, validated `redirectTo` when there
 * is one, else the configured default.
 */
const resolveAfterSignIn = (fallback: string): string => readRedirectTo() ?? fallback;

/**
 * Where a *just-completed sign-in* should land.
 *
 * Deliberately a different name from the field it falls back to, because two
 * things read `redirects.afterSignIn` and they are not interchangeable.
 *
 * This one is for a user who arrived at an auth screen — possibly via a bounce
 * that wrote `?redirectTo=…` — and has now signed in: honour the bounce. Every
 * sign-in flow uses it.
 *
 * The raw field is for sending the user somewhere that has nothing to do with a
 * sign-in the current URL describes: linking a social account from settings,
 * leaving an impersonation session, a `callbackURL` an emailed link opens days
 * later, or the accept-invitation screen that `?redirectTo` points *at*.
 * Resolving there would honour a parameter meant for a different journey, so
 * each of those four sites says in a comment that the bare read is deliberate.
 */
const postAuthDestination = (context: Pick<ControllerContext, "redirects">): string => resolveAfterSignIn(context.redirects.afterSignIn);

/**
 * Merge `parameters` into `path`'s existing query.
 *
 * Parsed rather than appended: blindly appending a second `?` mangles the URL
 * (its own parameters become part of the *first* query's last value), and
 * `URLSearchParams.set` overwrites rather than duplicating a key that already
 * exists — so a caller-supplied value always wins over whatever `path` already
 * carried, never silently loses to a second occurrence.
 */
const mergeQuery = (path: string, parameters: Readonly<Record<string, string>>): string => {
    const [base, existing = ""] = path.split("?");
    const merged = new URLSearchParams(existing);

    for (const [key, value] of Object.entries(parameters)) {
        merged.set(key, value);
    }

    return `${base ?? path}?${merged.toString()}`;
};

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

    /*
     * Merged rather than appended: an app whose `redirects.twoFactor` already
     * carries a `redirectTo` would otherwise end up with two, and
     * `URLSearchParams.get` returns the first — so the configured value would
     * win over the invitation target this function exists to carry.
     */
    return mergeQuery(path, { redirectTo: target });
};

export { isSafeRedirect, mergeQuery, postAuthDestination, readRedirectTo, withRedirectTo };
