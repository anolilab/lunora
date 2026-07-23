import { LunoraError } from "@lunora/errors";

/**
 * Thrown by `findFirstOrThrow` when no document matches the query.
 *
 * A `LunoraError` subclass (`code: "NOT_FOUND"`, `status: 404`) so the
 * cross-package transport mapper maps it to a 404 structurally (via
 * `isLunoraError`) without an `instanceof` check against `@lunora/do`.
 */
// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through `@lunora/do` constructible in TypeScript; a default export would mix with the barrel's named re-exports.
export class NotFoundError extends LunoraError {
    public constructor(message: string = "Document not found") {
        super("NOT_FOUND", message, { name: "NotFoundError" });
    }
}
