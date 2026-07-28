/**
 * Small, dependency-free field validators shared by the form controllers. Each
 * returns an error string or `undefined`, pulling copy from {@link Localization}
 * so messages stay translatable.
 */
import type { Localization } from "./localization";

// Pragmatic email shape — server-side better-auth is the source of truth; this is
// only to catch obvious typos before a round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

const MIN_PASSWORD_LENGTH = 8;

const required = (value: string, message: string): string | undefined => (value.trim() === "" ? message : undefined);

const email = (value: string, localization: Localization): string | undefined => {
    const missing = required(value, localization.emailRequired);

    if (missing) {
        return missing;
    }

    return EMAIL_RE.test(value.trim()) ? undefined : localization.emailInvalid;
};

const password = (value: string, localization: Localization): string | undefined => {
    const missing = required(value, localization.passwordRequired);

    if (missing) {
        return missing;
    }

    return value.length < MIN_PASSWORD_LENGTH ? localization.passwordTooShort : undefined;
};

export { email, MIN_PASSWORD_LENGTH, password, required };
