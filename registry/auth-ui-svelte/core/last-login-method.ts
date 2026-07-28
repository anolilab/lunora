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
 */

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

export { LAST_LOGIN_METHOD_COOKIE, readLastLoginMethod };
