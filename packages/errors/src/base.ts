/**
 * `LunoraError` — the one canonical error type for the whole framework.
 *
 * It extends `@visulima/error`'s {@link VisulimaError} (so it inherits `hint`,
 * `title`, `location`, and `cause`, and is renderable by `renderError` at the
 * CLI/overlay edge) and adds the transport fields Lunora needs: a machine
 * `code`, an HTTP/RPC `status`, an optional `docsUrl`, and an optional
 * wire-encodable `data` payload. Constructing one looks its defaults up in the
 * central {@link ERROR_CATALOG} by `code`, so a bare `new LunoraError("NOT_FOUND")`
 * already carries the right status/title/hint.
 *
 * All added fields are own-enumerable, so they ride the existing wire codec
 * (`shared/wire-codec.ts`) automatically when a `LunoraError` is embedded in a
 * payload, and the runtime/DO mappers copy them into the top-level error
 * envelope for the client, CLI, and Studio to render.
 *
 * NOTE: this module imports only the `VisulimaError` class (never `renderError`)
 * so the Node-only rendering subgraph stays tree-shakeable out of the browser
 * client and workerd runtime bundles. The renderer lives in `./render`.
 */
import { VisulimaError } from "@visulima/error/error";

import type { ErrorCatalogEntry, ErrorHint, LunoraErrorCode } from "./catalog";
import { ERROR_CATALOG } from "./catalog";

/** Source location for an error (mirrors `@visulima/error`'s `ErrorLocation`). */
export interface ErrorLocation {
    column?: number;
    file?: string;
    line?: number;
}

/** Options for {@link LunoraError}. Explicit values override the catalog defaults. */
export interface LunoraErrorOptions {
    /** Underlying error/value that triggered this one. */
    cause?: unknown;
    /** Structured, JSON+wire-encodable payload surfaced to the client alongside `code`. */
    data?: unknown;
    /** Link to deeper docs for this error. */
    docsUrl?: string;
    /** Actionable fix (Markdown). Defaults to the catalog entry's hint. */
    hint?: ErrorHint;
    /** Source location, when known (e.g. a codegen/schema diagnostic). */
    location?: ErrorLocation;
    /** Override the error `name` (e.g. a subclass like `"ConflictError"`). */
    name?: string;
    /** Override the transport status. Defaults to the catalog entry's status, else 500. */
    status?: number;
    /** Override the short title. Defaults to the catalog entry's title. */
    title?: string;
}

/**
 * A code string: a well-known {@link LunoraErrorCode} (with autocomplete) or any
 * package-specific code not yet in the catalog.
 */
export type LunoraErrorCodeInput = LunoraErrorCode | (string & {});

export class LunoraError extends VisulimaError {
    /** Machine-readable reason, keyed into {@link ERROR_CATALOG}. */
    public readonly code: string;

    /** HTTP/RPC status for the transport mappers. */
    public readonly status: number;

    /** Optional link to deeper docs. */
    public readonly docsUrl: string | undefined;

    /** Optional structured payload propagated verbatim to the client. */
    public readonly data: unknown;

    public constructor(code: LunoraErrorCodeInput, message?: string, options: LunoraErrorOptions = {}) {
        const entry: ErrorCatalogEntry | undefined = (ERROR_CATALOG as Record<string, ErrorCatalogEntry>)[code];

        super({
            cause: options.cause,
            hint: options.hint ?? entry?.hint,
            location: options.location,
            message: message ?? entry?.title ?? code,
            name: options.name ?? "LunoraError",
            title: options.title ?? entry?.title,
        });

        this.code = code;
        this.status = options.status ?? entry?.status ?? 500;
        this.docsUrl = options.docsUrl ?? entry?.docsUrl;
        this.data = options.data;
    }
}
