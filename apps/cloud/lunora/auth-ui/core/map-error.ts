/**
 * One shared error path for every controller. better-auth client calls resolve
 * to `{ data, error }` rather than throwing, so {@link assertOk} converts a
 * populated `error` into a thrown {@link AuthActionError}; {@link mapAuthError}
 * then turns any thrown value — an `AuthActionError`, a `LunoraError`, or an
 * unknown — into a single user-facing string. This keeps every flow's catch
 * block identical.
 */
import { LunoraError } from "@lunora/errors";

import type { Localization } from "./localization";
import type { AuthFetchError, AuthResponse } from "./types";

/** A thrown wrapper around a better-auth `{ error }` payload. */
class AuthActionError extends Error {
    public readonly code?: string;

    public readonly status?: number;

    public constructor(error: AuthFetchError) {
        super(error.message ?? error.statusText ?? "Authentication request failed");
        this.name = "AuthActionError";
        this.code = error.code;
        this.status = error.status;
    }
}

/** Throw an {@link AuthActionError} when a better-auth response carries an error. */
const assertOk = <T>(response: AuthResponse<T>): AuthResponse<T> => {
    if (response.error) {
        throw new AuthActionError(response.error);
    }

    return response;
};

/**
 * Codes better-auth answers with when the session is too old for a sensitive
 * operation (changing an email or password, revoking sessions, deleting an
 * account). Its own message — "session is not fresh" — describes the mechanism,
 * not what the user should do, so this is one of the few worth rewording: the
 * action did not fail, it needs a re-authentication first.
 */
const NOT_FRESH_CODES = new Set(["SESSION_NOT_FRESH", "SESSION_TOO_OLD"]);

/**
 * Map a thrown value to a display string. better-auth already returns
 * human-readable messages ("Invalid email or password"), so those pass through;
 * `LunoraError`s use their message; anything else falls back to `fallback`.
 */
const mapAuthError = (error: unknown, localization: Localization, fallback: string): string => {
    if (error instanceof AuthActionError) {
        if (error.code !== undefined && NOT_FRESH_CODES.has(error.code)) {
            return localization.sessionNotFresh;
        }

        return error.message.trim() === "" ? fallback : error.message;
    }

    if (error instanceof LunoraError) {
        return error.message.trim() === "" ? fallback : error.message;
    }

    return fallback === "" ? localization.genericError : fallback;
};

export { assertOk, AuthActionError, mapAuthError };
