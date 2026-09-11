/**
 * Turn a thrown value into something a user can read.
 *
 * The kit's functions throw `LunoraError` with a code chosen to mean something
 * to the screen (`FAILED_PRECONDITION` is "you have no organisation", which is
 * an onboarding prompt, not a failure). This maps the ones the kit raises and
 * falls through to the server's own message for everything else — an unmapped
 * code is better shown than swallowed.
 */
const MESSAGES: Record<string, string> = {
    ALREADY_EXISTS: "That name is already taken.",
    FAILED_PRECONDITION: "You need an organization before you can do that.",
    FORBIDDEN: "You do not have permission to do that.",
    INVALID_ARGUMENT: "That value is not valid.",
    NOT_FOUND: "That item no longer exists.",
    RATE_LIMITED: "Too many requests — try again in a moment.",
    UNAUTHORIZED: "Please sign in and try again.",
};

/**
 * A thrown value's error code, when it carries one. Structural rather than an
 * `instanceof LunoraError` check: the error crosses a WebSocket and is
 * reconstructed client-side, so prototype identity is not guaranteed.
 */
const errorCode = (error: unknown): string | undefined => {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    const { code } = error as { code?: unknown };

    return typeof code === "string" ? code : undefined;
};

const mapError = (error: unknown): string => {
    const code = errorCode(error);

    if (code && MESSAGES[code]) {
        return MESSAGES[code];
    }

    if (error instanceof Error && error.message) {
        return error.message;
    }

    return "Something went wrong.";
};

export { errorCode, mapError, MESSAGES };
