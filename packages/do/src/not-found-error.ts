/**
 * Thrown by `findFirstOrThrow` when no document matches the query.
 *
 * Like `ConflictError`, `code` / `status` are declared as own properties
 * so the cross-package structural error mapper maps it to a 404 without an
 * `instanceof` check against `@lunora/do`.
 */
class NotFoundError extends Error {
    public readonly code: string = "NOT_FOUND";

    public readonly status: number = 404;

    public constructor(message: string = "Document not found") {
        super(message);
        this.name = "NotFoundError";
    }
}

export default NotFoundError;
