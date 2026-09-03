import type { FunctionReference, LunoraClient } from "@lunora/client";

/**
 * Dispatch a Lunora RPC through the client method that matches the function's
 * `kind`: an `action` runs via `client.action`, a `mutation` via `client.mutation`,
 * and everything else (a `query`) via `client.query`. The single home for that
 * kind→method fan-out, shared by the API "try it" console and the function runner so
 * a future kind — or a change in how admin surfaces should dispatch a kind — is
 * fixed in one place. `options` carries the (optional) shard key; `args`/return are
 * `unknown` because the caller supplies runtime-parsed JSON.
 */
export const dispatchByKind = (
    client: Pick<LunoraClient, "action" | "mutation" | "query">,
    kind: string | undefined,
    reference: FunctionReference,
    args: unknown,
    options: { shardKey?: string },
): Promise<unknown> => {
    switch (kind) {
        case "action": {
            return client.action(reference, args, options);
        }
        case "mutation": {
            return client.mutation(reference, args, options);
        }
        default: {
            return client.query(reference, args, options);
        }
    }
};

/**
 * Build a {@link FunctionReference} for a reserved admin RPC path. All admin
 * RPCs are intercepted by `ShardDO` by `functionPath` regardless of which
 * client method carries them, so the studio routes every admin call through
 * `client.query` — a pure one-shot RPC with no optimistic/offline machinery.
 */
export const adminRef = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

/** Translate a free-text shard key into the client's call options. Empty → root shard. */
export const callOptions = (shardKey: string): { shardKey?: string } => {
    const trimmed = shardKey.trim();

    return trimmed === "" ? {} : { shardKey: trimmed };
};

/** Narrow an unknown thrown value to a human-readable message. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Extract the error `code` carried on a thrown value — a `LunoraClientError`
 * reconstructed from the server envelope exposes the catalog `code` (e.g.
 * `"LOG_ARCHIVE_NOT_CONFIGURED"`), letting a caller branch on a specific failure
 * (a "not configured" empty state vs. a real error). Returns `undefined` when the
 * value carries no string `code`.
 */
export const errorCode = (error: unknown): string | undefined => {
    if (error === null || typeof error !== "object" || !("code" in error)) {
        return undefined;
    }

    const { code } = error as { code?: unknown };

    return typeof code === "string" ? code : undefined;
};

/**
 * Extract an actionable hint (Markdown) carried on a thrown value — a
 * `LunoraClientError` reconstructed from the server envelope exposes `hint` as a
 * string or an array of lines. Returns `undefined` when the error carries none.
 */
export const errorHint = (error: unknown): string | undefined => {
    if (error === null || typeof error !== "object" || !("hint" in error)) {
        return undefined;
    }

    const { hint } = error as { hint?: unknown };

    if (typeof hint === "string") {
        return hint;
    }

    return Array.isArray(hint) ? hint.filter((line): line is string => typeof line === "string").join("\n") : undefined;
};

/**
 * Extract a documentation URL (the wire `docsUrl` field) carried on a thrown
 * value (a `LunoraClientError`), or `undefined`. Only `http(s)` URLs are
 * returned — a `javascript:`/`data:` scheme would be an XSS sink once rendered
 * as an `href`, so anything else is dropped even though `docsUrl` normally comes
 * from the trusted catalog (defense-in-depth against a crafted error envelope).
 */
export const errorDocumentationUrl = (error: unknown): string | undefined => {
    if (error === null || typeof error !== "object" || !("docsUrl" in error)) {
        return undefined;
    }

    const value = (error as { docsUrl?: unknown }).docsUrl;

    if (typeof value !== "string") {
        return undefined;
    }

    try {
        const { protocol } = new URL(value);

        return protocol === "http:" || protocol === "https:" ? value : undefined;
    } catch {
        // Not an absolute URL (or unparseable) → don't render it as a link.
        return undefined;
    }
};

/**
 * Render a byte count compactly (e.g. `1.4 MB`). `null`/`undefined` render as an
 * em dash so panels can pass an absent size straight through.
 */
export const formatBytes = (bytes: null | number | undefined): string => {
    if (bytes === null || bytes === undefined) {
        return "—";
    }

    if (bytes < 1024) {
        return `${bytes.toString()} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit] ?? "TB"}`;
};

/**
 * `JSON.stringify` replacer for row data.
 *
 * `LunoraClient` decodes the wire codec on the way in, so a `v.bigint()` column
 * reaches the studio as a real `bigint` and a `v.bytes()` column as an
 * `ArrayBuffer`. `JSON.stringify` **throws** on the former and flattens the
 * latter to `{}` — so any surface that serializes a row (the JSON view, the JSON
 * export) dies or loses data on a table like `paymentSessions`. Both render
 * exactly as {@link formatCell} renders them; JSON has no bigint, so a decimal
 * string is the honest form.
 *
 * Only those two kinds are touched — every other value serializes unchanged.
 */
export const jsonRowReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") {
        return value.toString();
    }

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return `<bytes: ${formatBytes(value.byteLength)}>`;
    }

    return value;
};

/**
 * Render a single table-cell value as text without throwing on objects or null.
 * Shared by the shard and global data browsers so cell rendering can't drift
 * between them.
 */
export const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    switch (typeof value) {
        case "bigint":
        case "boolean":
        case "number": {
            return value.toString();
        }
        case "string": {
            return value;
        }
        case "symbol": {
            return value.toString();
        }
        default: {
            // A `v.bytes()` column decodes to an ArrayBuffer (or a typed-array
            // view for a custom scalar). `JSON.stringify` renders an ArrayBuffer
            // as a bare `{}` and a typed array as its indices (`{"0":1,"1":2}`) —
            // neither tells the operator anything. Show the size instead; the
            // bytes are not meaningfully readable in a grid cell.
            //
            // Only bytes are special-cased because `v.bytes()` is the only codec
            // kind a validated document can hold: `Map`/`Set` have no validator,
            // so they reach a cell only in a document written around the schema.
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return `<bytes: ${formatBytes(value.byteLength)}>`;
            }

            // A NESTED bigint/bytes cell would throw / flatten here for exactly
            // the reasons {@link jsonRowReplacer} exists, so route through it.
            // That keeps `formatCell` total over every value a decoded document
            // can hold — which the CSV and SQL exports rely on.
            return JSON.stringify(value, jsonRowReplacer);
        }
    }
};

/**
 * Fire a promise without awaiting it, so an event handler or effect can kick one
 * off and return `void` without leaving a floating promise.
 *
 * By default the studio's async loaders already surface their own errors into
 * panel state via internal try/catch, so the rejection is swallowed here. For a
 * promise that does *not* self-handle (a bare mutation/migration/import/delete),
 * pass `onError` to route the failure into the calling panel's error surface —
 * otherwise it would silently no-op. New state-changing call sites should pass
 * `onError`; navigation and self-handling loaders intentionally stay silent.
 */
export const fireAndForget = (promise: Promise<unknown>, onError?: (error: unknown) => void): void => {
    promise.catch((error: unknown) => {
        onError?.(error);
        /* default: loaders surface their own errors into panel state */
    });
};

/**
 * The Worker origin the studio is served from — what an API caller (or an MCP
 * client's `LUNORA_URL`) points at. An `explicit` value wins when provided;
 * otherwise falls back to `location.origin`, then the dev-server origin under
 * SSR/tests. The single home for that dev-origin constant so it can't drift
 * between call sites.
 */
export const resolveOrigin = (explicit?: string): string => {
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }

    const loc = (globalThis as { location?: { origin?: string } }).location;

    if (loc?.origin !== undefined && loc.origin !== "") {
        return loc.origin;
    }

    return "http://localhost:5173";
};

/**
 * Copy `text` to the clipboard when the browser exposes one; a no-op under
 * SSR/tests or an insecure context without `navigator.clipboard`. The single
 * home for the studio's copy buttons so the (browser-only) guard and its lint
 * exception live in one place. Returns whether a clipboard was available (the
 * write was kicked off) so callers can skip a "Copied" acknowledgement when it
 * wasn't.
 */
export const copyToClipboard = (text: string): boolean => {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard, guarded by the "navigator" in globalThis check
    const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

    if (clipboard === undefined) {
        return false;
    }

    fireAndForget(clipboard.writeText(text));

    return true;
};

/**
 * Quote a SQL identifier (table/column) with double quotes, doubling any embedded
 * quote — handles names like `query-result` that aren't bare identifiers.
 *
 * Re-exported from `shared/quote-identifier.ts` rather than defined here. That
 * file is the canonical quoter for `@lunora/d1`, `@lunora/do` and
 * `@lunora/shard-engine`, and it says why in its own doc comment: identifier
 * quoting is the sole defense against identifier injection wherever a name is
 * spliced into raw SQL, so it must have exactly ONE definition rather than
 * byte-identical copies that can drift. The studio had such a copy; the local
 * name is kept because the index-DDL composer and the SQL exporter call it.
 */
export { quoteIdentifier as sqlIdentifier } from "../../../../shared/quote-identifier";

/**
 * Render an epoch-ms or ISO timestamp as a locale string. Absent values render
 * as `fallback` (blank by default; pass `"—"` for a placeholder); an
 * unparseable value falls back to its raw string so nothing is hidden.
 */
export const formatTimestamp = (value: null | number | string | undefined, fallback = ""): string => {
    if (value === null || value === undefined || value === "") {
        return fallback;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};
