/**
 * "You signed in with GitHub last time" — the badge that saves a user from
 * guessing which of five buttons is theirs.
 *
 * better-auth's `lastLoginMethod` plugin writes a plain, unsigned cookie on
 * successful sign-in. Reading it here rather than calling an endpoint is
 * deliberate: it is a hint for ordering buttons, it must be available before the
 * first paint, and a request to learn it would cost more than it saves.
 *
 * It is *not* an authorization signal, and nothing in this package treats it as
 * one — the cookie is attacker-writable and only ever selects a label.
 *
 * # The values it can hold
 *
 * better-auth's default resolver records the **OAuth provider id** for a social
 * callback (`github`, `google`, …) and one of a small set of literals otherwise:
 * {@link LAST_METHOD_EMAIL} for password sign-in/sign-up,
 * {@link LAST_METHOD_MAGIC_LINK}, {@link LAST_METHOD_PASSKEY}, and `siwe`.
 *
 * That matters because badging only the social buttons — the obvious reading —
 * makes the feature do nothing for the most common case there is. A `customResolveMethod`
 * server-side can record anything, so treat an unrecognised value as "no badge"
 * rather than as an error.
 *
 * # Under SSR
 *
 * There is no `document` server-side, so this returns undefined there and the
 * badge exists only in the client render — a genuine hydration difference, in
 * a decorative `<span>` and nothing else. Unlike `core/theme-mode.ts`'s
 * divergence this one *does* write to the DOM, so an SSR app that wants the two
 * renders identical has to keep the cookie out of the first paint itself. Every
 * port reads it at render/setup time for the same reason: it is available
 * before the first paint, and deferring it to an effect trades the mismatch for
 * a visible pop-in on the screen users see most.
 */

/** Recorded for `/sign-in/email` and `/sign-up/email`. */
const LAST_METHOD_EMAIL = "email";

/** Recorded for a magic-link verification. */
const LAST_METHOD_MAGIC_LINK = "magic-link";

/** Recorded for a WebAuthn authentication. */
const LAST_METHOD_PASSKEY = "passkey";

/** The cookie better-auth's `lastLoginMethod` plugin writes. */
const LAST_LOGIN_METHOD_COOKIE = "better-auth.last_used_login_method";

/**
 * The last method used to sign in on this device, or undefined when there is no
 * cookie (a first visit, a cleared jar, or the plugin isn't installed).
 */
const readLastLoginMethod = (cookieName: string = LAST_LOGIN_METHOD_COOKIE): string | undefined => {
    const cookie = (globalThis as { document?: { cookie?: string } }).document?.cookie;

    if (cookie === undefined || cookie === "") {
        return undefined;
    }

    for (const part of cookie.split(";")) {
        const separator = part.indexOf("=");

        if (separator === -1) {
            continue;
        }

        if (part.slice(0, separator).trim() !== cookieName) {
            continue;
        }

        const value = decodeURIComponent(part.slice(separator + 1).trim());

        return value === "" ? undefined : value;
    }

    return undefined;
};

export { LAST_LOGIN_METHOD_COOKIE, LAST_METHOD_EMAIL, LAST_METHOD_MAGIC_LINK, LAST_METHOD_PASSKEY, readLastLoginMethod };
