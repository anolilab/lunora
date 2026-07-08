/**
 * Structural, realm-safe recognizers for Lunora errors.
 *
 * `instanceof LunoraError` is unreliable across the workerd DO↔worker RPC
 * boundary and for errors rebuilt from the wire (which decode to a plain `Error`
 * carrying the copied own props). The transport mappers therefore key off the
 * structural shape — a string `code` plus a numeric `status` — via {@link isLunoraError}.
 * This single predicate replaces the former scattered `name === "LunoraError"` /
 * `name === "ConflictError"` allow-lists, which is what fixes the latent gap
 * where `NotFoundError`/`NotUniqueError`/`RlsRequiredError` (whose names were in
 * no matcher) were redacted to a generic 500.
 */
import type { ErrorHint } from "./catalog";

/** The wire-relevant shape of a Lunora error (a real `LunoraError` or a wire-decoded twin). */
export interface LunoraErrorLike extends Error {
    code: string;
    data?: unknown;
    docsUrl?: string;
    hint?: ErrorHint;
    status: number;
}

/**
 * True when `error` carries the Lunora transport shape (string `code` + numeric
 * `status` + the `VisulimaError` brand). The `type` brand is what distinguishes
 * a real `LunoraError` (or its wire-decoded twin) from a foreign error that
 * happens to carry `code`/`status` — see plan 119 for the full rationale.
 */
export const isLunoraError = (error: unknown): error is LunoraErrorLike => {
    if (!(error instanceof Error)) {
        return false;
    }

    const candidate = error as { code?: unknown; status?: unknown; type?: unknown };

    return candidate.type === "VisulimaError" && typeof candidate.code === "string" && typeof candidate.status === "number";
};
