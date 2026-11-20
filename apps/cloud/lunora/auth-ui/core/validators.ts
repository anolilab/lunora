/**
 * Small, dependency-free field validators shared by the form controllers. Each
 * returns an error string or `undefined`, pulling copy from {@link Localization}
 * so messages stay translatable.
 */
import type { Localization } from "./localization";
import type { PasswordPolicy } from "./password-policy";
import { validatePassword } from "./password-policy";

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

/**
 * Validate a password against `policy`, or against better-auth's own defaults
 * when a flow has no context to hand. The real rules live in
 * `password-policy.ts`; this stays as the shared entry point every form uses.
 */
const password = (value: string, localization: Localization, policy?: PasswordPolicy): string | undefined => validatePassword(value, localization, policy);

export { email, MIN_PASSWORD_LENGTH, password, required };
