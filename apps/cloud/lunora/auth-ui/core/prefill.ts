/**
 * Seeding a sign-up form from the link that sent the user there.
 *
 * The motivating case is an invitation: someone is invited as `ada@example.com`,
 * follows the link, and then has to type that address from memory. Typo it and
 * they create a *different* account, the invitation doesn't match it, and the
 * failure surfaces somewhere else entirely. `?email=` removes the retyping.
 *
 * # This is convenience, never a constraint
 *
 * A URL parameter is user-editable, so a "locked" field is a nicety and not a
 * control. `lockedPrefill` marks a field read-only so the intent is obvious and
 * the value isn't fumbled, but nothing here — and nothing that reads it — treats
 * that as enforcement. The invitation on the server is what decides which
 * address may accept it, and it has to keep deciding that whatever arrives.
 *
 * # Passwords are never prefilled
 *
 * {@link PREFILLABLE} is an allow-list rather than a deny-list. A password in a
 * query string ends up in browser history, in the referrer of every outbound
 * link on the page, and in any server log that records URLs — so this reads only
 * the fields that are safe to see there, and adding one is a deliberate act.
 */

import { queryParameter } from "./browser-location";

/** Fields that may be seeded from the URL. Deliberately small; never a secret. */
const PREFILLABLE = new Set(["email", "name", "username"]);

// A prefilled value lands in an input, so the only characters worth refusing are
// the control ones that could break out of the surrounding markup or a log line.
// eslint-disable-next-line no-control-regex -- detecting control characters is the point; the range is spelled out because that is what it is.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Read `field` from the current URL's query string.
 *
 * Returns undefined off the browser, for a field not on the allow-list, or for a
 * value carrying control characters.
 */
const readFieldPrefill = (field: string): string | undefined => {
    if (!PREFILLABLE.has(field)) {
        return undefined;
    }

    const value = queryParameter(field);

    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed === "" || CONTROL_CHARACTERS.test(trimmed) ? undefined : trimmed;
};

/**
 * Whether `field` should render read-only because the link supplied it.
 *
 * Only ever true when there is a value to lock *and* the app asked for locking —
 * see the note above about why this is presentation and not enforcement.
 */
const lockedPrefill = (field: string, lock: boolean | undefined): boolean => lock === true && readFieldPrefill(field) !== undefined;

export { lockedPrefill, PREFILLABLE, readFieldPrefill };
