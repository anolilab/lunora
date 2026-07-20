/**
 * The central Lunora error catalog — the single source of truth mapping a
 * machine-readable `code` to its transport `status`, a short human `title`, and
 * (where useful) an actionable Markdown `hint` plus a `docsUrl`.
 *
 * This table is consumed everywhere an error is surfaced: the runtime/DO wire
 * mappers (status), the client SDK (code discrimination), the CLI renderer and
 * the Vite overlay (hint), and the Studio UI (title + hint + docs link). It also
 * absorbs the former `@lunora/codegen` "solutions" table (see {@link MESSAGE_SOLUTIONS})
 * so codegen build-time errors — which are thrown as plain messages into
 * generated code and lose their class identity before a consumer sees them —
 * keep their message-matched hints.
 */

/** Markdown hint: a single string or an array of lines. Shape matches `@visulima/error`'s `hint`. */
export type ErrorHint = string | ReadonlyArray<string>;

/** A catalog entry: the fixed metadata for one error `code`. */
export interface ErrorCatalogEntry {
    /** Optional URL to deeper docs for this error. */
    docsUrl?: string;
    /** Optional actionable fix, authored as Markdown (rendered by CLI/overlay/Studio). */
    hint?: ErrorHint;

    /**
     * When `true`, this code's `message` must NOT cross the wire — an internal
     * failure or unhandled invariant may carry SQL fragments, file paths, or
     * internal identifiers. The transport mappers emit a generic message for
     * these (and log the real one server-side). See {@link isInternalCode}.
     */
    internal?: boolean;
    /** HTTP/RPC status this code maps to on the wire. */
    status: number;
    /** Short, human-readable summary. */
    title: string;
}

/**
 * Every well-known Lunora error code. Domain packages may throw additional
 * codes (passing an explicit `status`); those are added here as their package is
 * migrated. The keys of this object form the {@link LunoraErrorCode} union.
 */
export const ERROR_CATALOG = {
    BAD_REQUEST: { status: 400, title: "Bad request" },
    UNAUTHORIZED: { status: 401, title: "Unauthorized" },
    FORBIDDEN: { status: 403, title: "Forbidden" },
    NOT_FOUND: { status: 404, title: "Not found" },

    CONFLICT: {
        hint: [
            "Another write changed this row while your mutation was running (optimistic concurrency conflict).",
            "",
            "Re-read the row and retry the mutation with the fresh value. Lunora serializes a DO's mutations, so a persistent conflict usually means the handler conflicts **with itself** (e.g. a trigger or cascade touching the same row) — split that work rather than adding a retry loop.",
        ],
        status: 409,
        title: "Conflict",
    },
    NOT_UNIQUE: {
        hint: [
            "`.unique()` matched more than one document — it expects the query to identify at most one row.",
            "",
            "- If several matches are legitimate, use `.first()` (take one) or `.collect()` (take all) instead.",
            "- Otherwise tighten the query (e.g. filter on a unique/indexed field) so it can only match one row.",
        ],
        status: 400,
        title: "Query matched more than one document",
    },
    VALIDATION_ERROR: { status: 400, title: "Validation failed" },

    TOO_MANY_REQUESTS: { status: 429, title: "Too many requests" },
    UNPROCESSABLE: { status: 422, title: "Unprocessable" },
    NOT_IMPLEMENTED: { status: 501, title: "Not implemented" },

    /** RPC/REST dispatch codes emitted by the runtime + Durable Object router. */
    FUNCTION_NOT_FOUND: { status: 404, title: "Function not found" },
    METHOD_NOT_ALLOWED: { status: 405, title: "Method not allowed" },
    PAYLOAD_TOO_LARGE: { status: 413, title: "Payload too large" },

    /** Free-form internal failure — redacted to a generic message on the wire. */
    INTERNAL: { internal: true, status: 500, title: "Internal error" },
    /** Alias of {@link ERROR_CATALOG.INTERNAL} kept for `@lunora/server`'s historical code name. */
    INTERNAL_SERVER_ERROR: { internal: true, status: 500, title: "Internal error" },
    /** Non-mappable throw crossed the RPC boundary. */
    RPC_FAILED: { internal: true, status: 500, title: "Internal error" },

    COUNT_RLS_UNSUPPORTED: { status: 422, title: "count() is unsupported under an RLS policy" },
    MASK_UNSUPPORTED: { status: 422, title: "Aggregation over a masked column is unsupported" },
    RELATION_PREDICATE_UNSUPPORTED: { status: 422, title: "Relation predicate is unsupported in a write policy" },
    RLS_REQUIRED: {
        hint: [
            "This table is secure-by-default: it has no `.public()` marker and no RLS policy resolved for the caller, so the read fails closed.",
            "",
            "Add a read policy with `.rls(...)`, or mark the table `.public()` if it is intentionally world-readable.",
        ],
        status: 403,
        title: "RLS policy required",
    },

    RUN_DEPTH_EXCEEDED: { internal: true, status: 500, title: "Run depth exceeded" },
    MIGRATION_NOT_FOUND: { status: 404, title: "Data migration not found" },
    UNKNOWN_TABLE: { status: 404, title: "Unknown table" },
    GLOBAL_TABLE_NOT_EDITABLE: { status: 400, title: "Global table is not editable" },

    SHARD_ERROR: { status: 503, title: "Shard error" },
    SHARD_UNAVAILABLE: { status: 503, title: "Shard unavailable" },
    OFFLINE_IDENTITY_CHANGED: { status: 409, title: "Offline identity changed" },

    /** Package-specific codes. Build-time-only — never cross the RPC wire, so deliberately not `internal`. */
    CODEGEN_DIAGNOSTIC: { status: 500, title: "Codegen diagnostic" },
    /** Build-time-only — never crosses the RPC wire, so deliberately not `internal`. */
    SCHEMA_SNAPSHOT_PARSE: { status: 500, title: "Schema snapshot parse error" },
    /** Runtime-reachable (env.ts): message enumerates failing env key names — redact on the wire. */
    ENV_INVALID: { internal: true, status: 500, title: "Invalid environment" },
    /** Runtime-reachable (auth/middleware.ts): message carries auth-wiring guidance — redact on the wire. */
    AUTH_HEADERS_MISSING: { internal: true, status: 500, title: "Auth headers missing" },

    /**
     * Upstream Cloudflare API failures surfaced from an action. The message
     * carries the upstream response body (Cloudflare's own error text — trusted
     * infra, not user input), so it is echoed rather than redacted. `status`
     * here is a fallback; each throw passes the actual upstream HTTP status.
     */
    ANALYTICS_SQL_ERROR: { status: 502, title: "Analytics Engine SQL API error" },
    R2_SQL_ERROR: { status: 502, title: "R2 SQL API error" },
    WORKFLOWS_REST_ERROR: { status: 502, title: "Cloudflare Workflows REST API error" },
} as const;

// Shape validation kept as a standalone statement: `as const satisfies …` is not
// emittable under isolatedDeclarations (TS9010), but `LunoraErrorCode` needs the
// literal keys, so the catalog stays `as const` and its shape is checked here.
void (ERROR_CATALOG satisfies Record<string, ErrorCatalogEntry>);

/** A well-known Lunora error code (a key of {@link ERROR_CATALOG}). */
export type LunoraErrorCode = keyof typeof ERROR_CATALOG;

/**
 * Look up a catalog entry by `code`, or `undefined` when the code isn't
 * registered. The single guarded seam for reading `ERROR_CATALOG` by an
 * arbitrary string: because the catalog is a plain object literal, a bracket
 * read for an inherited key (e.g. `"constructor"`, `"toString"`) would resolve
 * to `Object.prototype`'s member instead of `undefined`, so this uses
 * `Object.hasOwn` to only ever return an own entry. Reused by the
 * `LunoraError` constructor, {@link isInternalCode}, and {@link resolveHint}.
 */
export const getCatalogEntry = (code: string): ErrorCatalogEntry | undefined =>
    Object.hasOwn(ERROR_CATALOG, code) ? (ERROR_CATALOG as Record<string, ErrorCatalogEntry>)[code] : undefined;

/**
 * True when `code` is an internal/redacted code — an internal failure or
 * unhandled invariant whose `message` must NOT cross the wire (it may carry SQL
 * fragments, file paths, or internal identifiers). Derived from the catalog's
 * `internal` flag so the redaction posture stays in one place (the table).
 * Throwing a `LunoraError` with any non-internal code is the author's vouch that
 * its message is client-safe; an unknown/unregistered code is treated as safe.
 */
export const isInternalCode = (code: string): boolean => getCatalogEntry(code)?.internal === true;

/**
 * A message-matched solution for errors that reach a consumer without a `code`
 * — chiefly `@lunora/codegen` build errors, which are thrown as plain messages
 * into generated code (and flattened to `{ message }` by the Vite overlay), so
 * the message text is the only stable join key. Ordered most- to least-specific;
 * the first matching rule wins.
 */
export interface Solution {
    /** Markdown body shown under the header. */
    body: string;
    /** Short header for the solution. */
    header: string;
    /** Stable id (used in DEBUG logs and tests). */
    id: string;
}

/** A {@link Solution} plus its message matcher. */
export interface SolutionRule extends Solution {
    /** True when this rule recognizes the error message. */
    test: (message: string) => boolean;
}

/**
 * Message-matched solutions (migrated verbatim from the former
 * `@lunora/codegen` solutions table). Re-exported by `@lunora/codegen` as
 * `LUNORA_SOLUTION_RULES` for backward compatibility.
 */
export const MESSAGE_SOLUTIONS: ReadonlyArray<SolutionRule> = [
    {
        body: [
            "Lunora codegen couldn't find a schema to generate from.",
            "",
            "Create `lunora/schema.ts` exporting a `defineSchema(...)` call:",
            "",
            "```ts",
            'import { defineSchema, defineTable, v } from "@lunora/server";',
            "",
            "export default defineSchema({",
            "  messages: defineTable({ body: v.string() }),",
            "});",
            "```",
            "",
            "Or run `lunora init` to scaffold Lunora (a sample `lunora/schema.ts` included) into your app.",
        ].join("\n"),
        header: "No Lunora schema found",
        id: "lunora-schema-missing",
        test: (message) => message.includes("defineSchema() not found") || message.includes("schema.ts not found at"),
    },
    {
        body: [
            "`defineSchema(...)` must be called with an **inline object literal** mapping table names to `defineTable(...)`:",
            "",
            "```ts",
            "export default defineSchema({",
            "  todos: defineTable({ title: v.string(), done: v.boolean() }),",
            "});",
            "```",
            "",
            "Codegen reads the schema statically, so it can't follow a variable or a spread — pass the object literal directly.",
        ].join("\n"),
        header: "`defineSchema()` needs an inline object literal",
        id: "lunora-schema-not-object-literal",
        test: (message) => message.includes("defineSchema() expects an object literal"),
    },
    {
        body: [
            "This table name collides with a built-in `ctx.db` member, so the generated client can't expose it.",
            "",
            "Rename the table to anything that isn't a reserved name (the error lists them) — e.g. `userAccounts` instead of `insert`.",
        ].join("\n"),
        header: "Table name is reserved",
        id: "lunora-table-reserved",
        test: (message) => message.includes("is reserved") && message.includes("ctx.db"),
    },
    {
        body: [
            "Two tables resolve to the same name — usually a base table and a schema **extension** both defining it.",
            "",
            "Rename one of them, or drop the duplicate from the extension. Each table name must be unique across `defineSchema(...)` and every `.extend(...)`.",
        ].join("\n"),
        header: "Duplicate table name",
        id: "lunora-table-duplicate",
        // Anchor on `.extend(` — the only Lunora throw for this is
        // `defineSchema(...).extend(...): table "x" already exists …`. Matching a
        // bare "already exists"/"extension" pair would false-positive on
        // unrelated forwarded errors (e.g. a "file already exists" + "extension").
        test: (message) => message.includes("already exists") && message.includes(".extend("),
    },
    {
        body: [
            '`.jurisdiction(...)` accepts only a **string literal** of `"eu"`, `"us"`, or `"fedramp"`:',
            "",
            "```ts",
            'defineSchema({ /* … */ }).jurisdiction("eu");',
            "```",
        ].join("\n"),
        header: "Invalid `.jurisdiction(...)` value",
        id: "lunora-jurisdiction",
        test: (message) => message.includes("unknown jurisdiction") || (message.includes("jurisdiction") && message.includes('"eu", "us", or "fedramp"')),
    },
    {
        body: [
            "The `unique` flag on an index must be a **literal** `true` or `false`, not a computed value — codegen needs to read it statically:",
            "",
            "```ts",
            'defineTable({ email: v.string() }).index("by_email", ["email"], { unique: true });',
            "```",
        ].join("\n"),
        header: "`unique` must be a literal",
        id: "lunora-unique-literal",
        test: (message) => message.includes("must be a literal") && message.includes("unique"),
    },
    {
        body: [
            "A declared container/workflow class isn't re-exported by your worker entry, so `wrangler deploy` would reject it.",
            "",
            "Add the generated re-export shown in the error to your worker entry (e.g. `src/index.ts`):",
            "",
            "```ts",
            'export * from "./lunora/_generated/containers";',
            "```",
        ].join("\n"),
        header: "Binding not exported by your worker entry",
        id: "lunora-worker-entry-export-gap",
        test: (message) => message.includes("not exported by your worker entry"),
    },
    {
        // Deliberately NOT ERROR_CATALOG.NOT_UNIQUE.hint: that code (and hint)
        // describes the read-side `.unique()` multi-match, while this matcher
        // fires on the WRITE-path message ("unique constraint violation on
        // <table>") thrown as a CONFLICT by an insert/patch breaching a
        // `unique` index — a different error class needing insert remediation.
        body: [
            "A row with the same value already exists in a `unique` index.",
            "",
            "- If you meant to upsert, use `ctx.db.<table>().upsert(...)` (or `.patch(...)` an existing row) instead of `.insert(...)`.",
            '- Otherwise pick a value that isn\'t already taken, and consider surfacing a friendly "already exists" message to the user.',
        ].join("\n"),
        header: "Unique constraint violation",
        id: "lunora-runtime-unique",
        test: (message) => message.includes("unique constraint violation on"),
    },
    {
        body: ERROR_CATALOG.CONFLICT.hint.join("\n"),
        header: "Optimistic concurrency conflict",
        id: "lunora-runtime-occ",
        test: (message) => message.includes("optimistic concurrency conflict"),
    },
];

/**
 * Flatten a Markdown hint to plain text for a terminal / non-Markdown surface:
 * drop code-fence markers and strip inline `**bold**` / `` `code` `` emphasis.
 * Shared by the CLI renderer and the Studio `ErrorAlert` so the two can't drift.
 */
export const flattenHint = (hint: ErrorHint): string =>
    (typeof hint === "string" ? hint : hint.join("\n"))
        .split("\n")
        .filter((line) => !line.startsWith("```"))
        .join("\n")
        .replaceAll(/\*\*(.+?)\*\*/gu, "$1")
        .replaceAll(/`([^`]+)`/gu, "$1");

/**
 * Find the first message-matched {@link Solution} for `message`, or `undefined`
 * if none recognize it. Re-exported by `@lunora/codegen` as `findLunoraSolution`.
 */
export const findSolutionByMessage = (message: string): Solution | undefined => {
    for (const rule of MESSAGE_SOLUTIONS) {
        if (rule.test(message)) {
            return { body: rule.body, header: rule.header, id: rule.id };
        }
    }

    return undefined;
};

/**
 * Resolve an actionable hint for an error: prefer a hint carried on the error
 * (or its `code`'s catalog entry), then fall back to a message match. Returns
 * `undefined` when nothing recognizes it.
 */
// eslint-disable-next-line sonarjs/function-return-type -- ErrorHint is intentionally `string | string[]`
export const resolveHint = (input: { code?: string; hint?: ErrorHint; message?: string } | string): ErrorHint | undefined => {
    if (typeof input === "string") {
        return findSolutionByMessage(input)?.body;
    }

    if (input.hint !== undefined) {
        return input.hint;
    }

    if (input.code !== undefined) {
        const entry: ErrorCatalogEntry | undefined = getCatalogEntry(input.code);

        if (entry?.hint !== undefined) {
            return entry.hint;
        }
    }

    return input.message === undefined ? undefined : findSolutionByMessage(input.message)?.body;
};
