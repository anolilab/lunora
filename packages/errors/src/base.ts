/**
 * `LunoraError` — the one canonical error type for the whole framework.
 *
 * It mirrors `@visulima/error`'s error model — the same `hint`, `title`, `loc`
 * (location), and `type: "VisulimaError"` fields — so `@visulima/error`'s
 * `renderError` renders it (and its actionable hint) directly at the CLI/overlay
 * edge, and adds the transport fields Lunora needs: a machine `code`, an HTTP/RPC
 * `status`, an optional `docsUrl`, and an optional wire-encodable `data` payload.
 * Constructing one looks its defaults up in the central `ERROR_CATALOG` by
 * `code`, so a bare `new LunoraError("NOT_FOUND")` already carries the right
 * status/title/hint.
 *
 * It intentionally does NOT `extend` `@visulima/error`'s `VisulimaError` class:
 * that class's module (`@visulima/error/error`) statically pulls the Node-only
 * `renderError` (which imports `node:module`), and bundlers inline the whole
 * barrel rather than tree-shaking it — which would drag `node:module` into the
 * browser client and workerd runtime bundles. Reimplementing the (tiny) shape
 * here keeps `@lunora/errors` genuinely zero-dependency and bundle-safe on every
 * runtime, while staying fully renderer-compatible.
 *
 * All fields are own-enumerable, so they ride the existing wire codec
 * (`shared/wire-codec.ts`) automatically when a `LunoraError` is embedded in a
 * payload, and the runtime/DO mappers copy them into the top-level error envelope
 * for the client, CLI, and Studio to render.
 */
import type { ErrorCatalogEntry, ErrorHint, LunoraErrorCode } from "./catalog";
import { getCatalogEntry } from "./catalog";

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

export class LunoraError extends Error {
    /**
     * Discriminator recognised by `@visulima/error`'s `renderError`/`isVisulimaError`
     * (`error.type === "VisulimaError"`), so a `LunoraError` renders like a native
     * `VisulimaError` — hint and all.
     */
    public readonly type = "VisulimaError";

    /** Actionable fix (Markdown), rendered by the CLI/overlay/Studio. */
    public readonly hint: ErrorHint | undefined;

    /** Short, human-readable summary (separate from `message`). */
    public readonly title: string | undefined;

    /** Source location, when known (mirrors `VisulimaError.loc`). */
    public readonly loc: ErrorLocation | undefined;

    /** Machine-readable reason, keyed into `ERROR_CATALOG`. */
    public readonly code: string;

    /** HTTP/RPC status for the transport mappers. */
    public readonly status: number;

    /** Optional link to deeper docs. */
    public readonly docsUrl: string | undefined;

    /** Optional structured payload propagated verbatim to the client. */
    public readonly data: unknown;

    public constructor(code: LunoraErrorCodeInput, message?: string, options: LunoraErrorOptions = {}) {
        const entry: ErrorCatalogEntry | undefined = getCatalogEntry(code);

        // No message supplied → default to the code (a stable, predictable
        // identifier). The human-readable `title` stays separate metadata.
        //
        // Only forward an options object when a cause exists: passing `{ cause }`
        // unconditionally installs an own `cause: undefined` property on every
        // error (ES2022 InstallErrorCause keys off `HasProperty`, not the value),
        // which makes presence checks (`"cause" in err`) spuriously true.
        super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause });

        this.name = options.name ?? "LunoraError";
        this.hint = options.hint ?? entry?.hint;
        this.title = options.title ?? entry?.title;
        this.loc = options.location;
        this.code = code;
        this.status = options.status ?? entry?.status ?? 500;
        this.docsUrl = options.docsUrl ?? entry?.docsUrl;
        this.data = options.data;
    }
}
