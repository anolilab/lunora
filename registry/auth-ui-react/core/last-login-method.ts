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
 * There is no `document` server-side, so a render-time read produces markup the
 * server could not have produced — a hydration mismatch. Every port therefore
 * reads it **after mount**, via {@link lastLoginMethodStore}: the first client
 * render matches the server exactly (no badge), and the badge appears on the
 * next frame. The cost is a one-frame pop-in on a decorative `<span>`; the
 * alternative is markup that disagrees with the server on the screen users see
 * most, which React 19 recovers from by discarding the server tree.
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

        const raw = part.slice(separator + 1).trim();

        let value: string;

        try {
            value = decodeURIComponent(raw);
        } catch {
            // `decodeURIComponent` throws `URIError` on a malformed escape ("%",
            // "%zz"). This cookie is attacker-writable (see above) and is read
            // during render in every port, so letting that escape would take the
            // whole sign-in card down to decorate a label. No badge is the right
            // answer for a value we cannot read.
            return undefined;
        }

        return value === "" ? undefined : value;
    }

    return undefined;
};

/**
 * Snapshot pair for reading the badge **after** hydration.
 *
 * `getServerSnapshot` is what makes this SSR-safe: it answers `undefined` on the
 * server AND for the hydrating client render, so both agree; React then
 * re-reads `getSnapshot` once hydration is finished. The other ports mirror the
 * same contract with their own post-mount primitive.
 *
 * `subscribe` is a no-op on purpose — better-auth writes the cookie during a
 * sign-in navigation, so its value cannot change under a mounted card. It exists
 * because `useSyncExternalStore` requires it.
 *
 * `getSnapshot` returns a string, and equal strings are `Object.is`-equal, so
 * the store cannot drive the re-render loop that a fresh object would.
 */
const lastLoginMethodStore = {
    getServerSnapshot: (): string | undefined => undefined,
    getSnapshot: (): string | undefined => readLastLoginMethod(),
    subscribe: (): (() => void) => () => undefined,
};

export { LAST_LOGIN_METHOD_COOKIE, LAST_METHOD_EMAIL, LAST_METHOD_MAGIC_LINK, LAST_METHOD_PASSKEY, lastLoginMethodStore, readLastLoginMethod };
