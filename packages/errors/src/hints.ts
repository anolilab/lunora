/**
 * The operator-facing half of the error catalog: the Markdown fix (`hint`) for
 * each catalog code, plus the message-matched {@link MESSAGE_SOLUTIONS} and the
 * Cloudflare platform-error table.
 *
 * Kept apart from `catalog.ts` because the browser client only needs a code's
 * `status`/`title` (it reads `ERROR_CATALOG` for its code set, and a thrown
 * `LunoraError` for its status), while this text is several KiB gzip that only
 * the server's envelope builder, the CLI, the Vite overlay, MCP and Studio ever
 * render. A client error carries the hint the server put on the wire instead.
 * Nothing on the client's import graph reaches this module, so a bundler drops
 * it from every browser bundle.
 */

import type { LunoraErrorCode } from "./catalog";

/**
 * Canonical Cloudflare support-docs pages for the two platform-error families.
 * Private module constants, referenced by the {@link CLOUDFLARE_PLATFORM_ERRORS}
 * table below.
 */
const CF_5XX_DOCS = "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/";
const CF_1XXX_DOCS = "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/";

/** SQLite phrases `SQLITE_TOOBIG` as "string or blob too big"; D1 surfaces the same text through its own error envelope. */
const ROW_TOO_BIG_RE = /string or blob too big/iu;

/** Markdown hint: a single string or an array of lines. Shape matches `@visulima/error`'s `hint`. */
type ErrorHint = string | ReadonlyArray<string>;

/** Shared by the `CONFLICT` code hint and the message-matched OCC solution. */
const CONFLICT_HINT: ReadonlyArray<string> = [
    "Another write changed this row while your mutation was running (optimistic concurrency conflict).",
    "",
    "Re-read the row and retry the mutation with the fresh value. Lunora serializes a DO's mutations, so a persistent conflict usually means the handler conflicts **with itself** (e.g. a trigger or cascade touching the same row) — split that work rather than adding a retry loop.",
];

/**
 * The actionable fix (Markdown) for each catalog code that has one, keyed by
 * code. Read through {@link getCatalogHint}, never by a bare bracket.
 */
const ERROR_HINTS: Readonly<Partial<Record<LunoraErrorCode, ErrorHint>>> = {
    DELIVERY_FENCED:
        "The operation may have committed. Retry with the same transport key; a committed result from an older authority epoch returns DELIVERY_RECEIPT_FENCED. Do not automatically retry with a new transport key.",
    DELIVERY_RECEIPT_FENCED:
        "The operation committed, but its stored result belongs to an older authority epoch. Do not automatically retry with a new transport ID. Recover through the application's durable operation key under current authorization.",
    CONFLICT: CONFLICT_HINT,
    NOT_UNIQUE: [
        "`.unique()` matched more than one document — it expects the query to identify at most one row.",
        "",
        "- If several matches are legitimate, use `.first()` (take one) or `.collect()` (take all) instead.",
        "- Otherwise tighten the query (e.g. filter on a unique/indexed field) so it can only match one row.",
    ],
    RLS_REQUIRED: [
        "This table is secure-by-default: it has no `.public()` marker and no RLS policy resolved for the caller, so the read fails closed.",
        "",
        "Add a read policy with `.rls(...)`, or mark the table `.public()` if it is intentionally world-readable.",
    ],
    TRANSACTION_LIMIT_EXCEEDED: [
        "A single mutation may only read and write a bounded amount before it is stopped.",
        "",
        "Narrow the read with an index (`.withIndex(...)`) instead of scanning the table, or split the write across several mutations — for a large backfill use `defineMigration` + `lunora migrate up`, which batches and checkpoints for you.",
        "",
        "The ceilings are deliberately conservative — they exist to stop one request taking down the whole shard. A deployment that genuinely needs bigger transactions can raise them by overriding the `transactionLimits()` seam on its generated shard class.",
        "",
        "A transaction that reaches 80% of any ceiling logs one `warn` line (event `lunora.transaction.near_limit`) naming the limit, so a function that only gets close on development data shows up before production data pushes it over.",
    ],
    MIGRATION_DRIFT: [
        "An applied SQL migration is never re-run, so the runner stopped before applying anything.",
        "",
        "- **Its text changed after it ran:** revert the edit and put the change in a new migration. If the edit is inert (a comment, whitespace, line endings), record the new hash with the `UPDATE` the message prints.",
        "- **Tracking rows predate versions and match no migration:** set each row's `version` with the `UPDATE` the message prints, so the runner can tell what already ran.",
    ],
    UNIQUE_INDEX_DUPLICATES: [
        "The index was not built, so requests to its store are refused until it is.",
        "",
        "Make one row keep each key. For a shard table, write a `defineMigration` in `lunora/migrations.ts` that deletes or merges the duplicates, deploy it, then run `lunora migrate up <id>` with that migration's id; the `lunora-migration-helper` skill covers the pattern. A `.global()` table lives in your SQL database, not a shard, so `defineMigration` does not reach it: delete or merge the duplicate rows directly in the database. Either way the index build is retried on its own, so no second deploy is needed.",
    ],
    OFFLINE_NOT_QUEUED:
        "A mutation sent with `onlineOnly: true` found its connection down or reconnecting (the shard had connected before), or, on a shard that has never connected, its request failed on the wire. It was refused instead of queued. Nothing was persisted or replayed; issue the call again once the connection is back. See [keeping a write off the queue](/docs/concepts/offline-first#keeping-a-write-off-the-queue).",
    IDENTITY_MISMATCH: [
        "A write queued offline was replayed on a session that now belongs to someone else (a sign-out, or another user's sign-in, while it waited), so the worker refused it rather than commit it as them.",
        "",
        "`@lunora/client` re-resolves the session on this refusal and settles the write itself. If every replay is refused while the same user stays signed in, your worker's `resolveIdentity` returns a different `userId` than better-auth's `user.id`, or the RPC request carries no session cookie.",
    ],
    JURISDICTION_MOVE: [
        "The schema declares `.jurisdiction(...)` and the project has DO-backed auth (`.auth({ namespace })`). Pinning the auth object to the jurisdiction resolves it to a new, empty one: every user, account and session stays in the unpinned object until copied across. Voice sessions are pinned without an acknowledgement: they store nothing, and their transcripts are rows in the already-pinned shards.",
        "",
        // eslint-disable-next-line no-secrets/no-secrets -- admin op names, not credentials
        'Acknowledge with `.jurisdiction("eu", { pinAuth: true })` and deploy, then copy the auth tables across with the `__lunora_admin__:copyAuthToJurisdiction` admin op and, once the counts check out, purge the unpinned copy with `__lunora_admin__:purgeUnpinnedAuth` (see [Pinning auth and voice](/docs/concepts/data-residency#pinning-auth-and-voice)). For D1-mode auth the acknowledgement changes nothing.',
    ],
    INDEX_FIELD_NESTED_PATH:
        "Indexes cover top-level columns only. Denormalise the nested value into its own column, index that, and keep it in sync with a table `.triggers()` beforeInsert/beforeUpdate.",
    EMAIL_DOMAIN_BLOCKED: [
        "This address's domain is on the disposable/throwaway blocklist (or your configured deny-list).",
        "",
        "Sign up with a permanent mailbox. To tune the policy, pass `blockDisposable` / `allowDomains` / `denyDomains` in the `EmailGateConfig` you hand `assertEmailAllowed` / `classifyEmail` / `emailGateMiddleware` (`@lunora/auth/email-guard`).",
    ],
    EMAIL_UNDELIVERABLE: [
        "The address's domain publishes no MX (or fallback A/AAAA) records, so it can't receive mail.",
        "",
        "Check for a typo in the domain. MX verification is opt-in (`mx: true`) and needs DNS — leave it off on the edge path if DNS is unavailable.",
    ],
    AUTH_MIGRATOR_UNSUPPORTED: [
        "better-auth migrates only through its Kysely adapter, so `ensureMigrated` / `compileMigrationsSql` need the raw D1 binding as `database` — a custom adapter (`lunoraD1Adapter`, `lunoraAuthAdapter`, `lunoraDoAdapter`) cannot be migrated through, and neither can an absent `database`.",
        "",
        "Build a SECOND, migration-only instance over the raw binding — `createMigrationAuth({ ...options, database: env.DB })` (from `@lunora/auth/migrate`) — and hand that one to `ensureMigrated`. Keep the adapter on the instance that serves requests: the adapter exists to dodge a dev-runner hang in `$context`, which the migration instance never resolves.",
        "",
        "To compile the SQL off-platform (`compileMigrationsSql`), diff against an empty local database — `new DatabaseSync(':memory:')` from `node:sqlite` — rather than passing no `database` at all.",
    ],
    AUTH_CIMD_FETCH_NOT_PUBLIC:
        'Add "global_fetch_strictly_public" to "compatibility_flags" in wrangler.jsonc, so CIMD metadata fetches cannot reach private addresses. `lunora doctor` reports it as `cimd-fetch-not-strictly-public`.',
    AUTH_MCP_RESOURCE_AMBIGUOUS:
        'Use `mcp` from "@lunora/auth/plugins" (not `@better-auth/mcp`) and pass the plugin object as is: it records its `resource`, which the worker needs to serve the protected-resource metadata when the provider names several resources.',
    AUTH_MCP_RESOURCE_INVALID:
        "Pass `resource` to `requireMcpAuth` (and `mcp()`) as the absolute URL of the MCP route, e.g. `https://app.example.com/mcp`: issued tokens are audience-bound to it.",
    MCP_STEP_UP_MISCONFIGURED:
        "Give `createAuthedMcpFetchHandler`'s `stepUp` a non-empty `scope` (such as `lunora:write`) and a `challenge` (`createInsufficientScopeError` from `@lunora/auth/plugins`), or leave `stepUp` out.",
    BACKUP_RETENTION_NOT_CONFIGURED: [
        "`lunora backup prune` removes snapshots past the retention window, and this worker has no window: set `backupRetain` (how many to keep) and `backupCron` (which decides whose snapshots retention owns) on `createWorker`.",
        "",
        "Nothing was deleted. A default is deliberately not invented here — retention deleting on its own is exactly what this command exists to replace.",
    ],
    BACKUP_TOO_LARGE: [
        "The scheduled backup is assembled inside the Worker isolate, so it caps the snapshot it will build. Nothing was written.",
        "",
        "The cap is on the NDJSON, not on peak memory: the export fan-out resolves every shard's rows before the first row is encoded, so a snapshot under the cap can still exhaust the isolate. It is set well below the isolate's limit for that reason.",
        "",
        "Narrow the snapshot with `backupTables`, or take this backup off-platform with `lunora backup create --bucket`, which runs on a machine rather than in an isolate. Backing up more often does not help — every run is a full snapshot.",
    ],
    EXPORT_SHARD_FAILED: [
        "One or more shards failed to export, so the snapshot would have been short. Nothing is written when this fires — a partial export must never be mistaken for a complete one.",
        "",
        "The message names each failed shard key and its error. Re-run the export once those shards are reachable; a shard that fails repeatedly is usually over the per-request memory budget, which `backupTables` narrows.",
    ],
    ID_COLLISION: [
        "The imported row carries an `_id` that is already held by a DIFFERENT table in this shard. Ids are per-table, so inserting it would leave two tables claiming one id and make a later lookup resolve to whichever one it reached first.",
        "",
        "This is reported per row rather than aborting the import: the remaining rows still apply. Re-mint the id on the source side, or import that table into a shard that does not already hold it.",
        "",
        "Only shard tables raise it. A `.global()` table names its table on every by-id call, so the same id in two global tables is two separate rows and the import accepts it.",
    ],
    STORAGE_CHECKSUM_MISMATCH: [
        "The upload body did not match the declared `expectedSize` or `expectedSha256`, so nothing was written — this check fails closed.",
        "",
        "Re-read the bytes from the source export and retry the transfer. A persistent mismatch means the source blob is corrupt or truncated; fix the export rather than bypassing the check.",
    ],
    STORAGE_DOWNLOAD_NOT_CONFIGURED: [
        "`GET /_lunora/admin/storage/object` needs a `storageDownload` function on the worker. The generated app worker wires it up; a hand-written `createWorker({ ... })` has to pass `(key, opts) => pick(opts?.bucket).download(key)` — forwarding `opts.bucket` to the right bucket, and wrapping rather than passing `createStorage(...).download` itself, whose second parameter is a byte range.",
        "",
        "Without it a bucket-backed `lunora backup restore --bucket` cannot read the snapshot. The object is still readable out of band with `wrangler r2 object get`.",
    ],
    RAG_DIMENSION_MISMATCH: [
        "A stored vector and the query embedding have different widths, so they cannot be compared.",
        "",
        "This is what changing a RAG index's `embeddingModel` (or a provider's `dimensions` option) without reindexing looks like. Either put the previous model back, or reindex the namespace under the new one — bump `embeddingModelVersion` so the index rebuilds instead of mixing widths.",
    ],
    AUTH_MOVE_NOT_CONFIGURED:
        "The copy needs DO-backed auth (`.auth({ namespace })`) pinned with `.jurisdiction(…, { pinAuth: true })`, and the auth object's `internalSecret` set.",
    AUTH_MOVE_TARGET_NOT_EMPTY:
        "The pinned auth object holds users the copy did not write (someone signed up there), so copying into it would merge two user bases. Pass `force: true` to copy anyway: a copied row that collides with one of the pinned object's rows is left out and counted under `conflicts`.",
    AUTH_MOVE_CONFLICT:
        "A copied row has the same key or unique value (such as an email) as a row the pinned auth object holds on its own, or the pinned object changed a row the source changed too. Nothing from that page was written. Pass `force: true` to keep the pinned object's rows and count the collisions under `conflicts`.",
    AUTH_MOVE_SOURCE_CHANGED:
        "The un-pinned auth object changed after the copy read it (an update, a delete, or a new row), for example during a gradual rollout or a rollback. Run the copy again: it reconciles the changed tables. Then purge.",
    AUTH_MOVE_SOURCE_PURGED:
        "The un-pinned auth object was already purged. Its tables may exist again (a rollback served requests there), but they hold only rows written since, so the copy refuses rather than read them as deletions and remove the pinned object's users. Nothing is left to copy.",
    // eslint-disable-next-line no-secrets/no-secrets -- an admin op name, not a credential
    AUTH_MOVE_INCOMPLETE: "Run `__lunora_admin__:copyAuthToJurisdiction` until it answers `done: true`, check the per-table counts, then purge.",
    AUTH_MOVE_FAILED:
        "The message names the step, the table and the class of the SQLite error; the auth object's log has the full error. The copy resumes where it stopped once the cause is fixed.",
    DISPATCH_UNAUTHENTICATED:
        "The scheduler could not authenticate to the worker. Check that `LUNORA_SCHEDULER_SECRET` matches on both sides, or that `LUNORA_ADMIN_TOKEN` is set and current.",
    DISPATCH_IN_PROGRESS:
        "A dispatch with this idempotency id is still running on the shard. Retry it; once the first attempt settles the same id is served from the replay cache.",
    TOKEN_EXPIRED: [
        "The caller's credential verified but its expiry has passed. The worker refuses an HTTP call with this code before it runs; a shard drops a socket with close code `4001` and the same code.",
        "",
        "It is a refusal of the credential, not of the call: `@lunora/client` holds a queued write, fires `onTokenExpired`, and re-sends it after `setAuthToken`. The held write survives the refresh only if you pass the same `subject` (the user id) with the new token, `setAuthToken(freshToken, user.id)`; without one a refresh reads as a user switch and the write is rejected `OFFLINE_IDENTITY_CHANGED`. Under a cookie session there is no token to replace: renew the cookie and the write is re-sent on a backoff. The worker can only tell expired from anonymous if your `resolveIdentity` returns the identity with its past `exp` (or `expiresAtMs`), or throws a `LunoraError` with this code. Returning `null` runs the call anonymous.",
    ],
    TOO_MANY_WHISPER_TOPICS:
        "Reuse a stable set of whisper topic names, or reconnect — the per-socket verdict memo is in-memory, so a new connection starts empty. Leaving a topic does not free its entry.",
    HTTP_STREAM_NO_BODY: [
        "The `fetch` implementation resolved with a response that exposes neither a `body` stream nor a `text()` read — a broken `fetch` substitute, not a runtime limitation.",
        "A response with no `body` stream that can still be read as text (React Native's `whatwg-fetch` polyfill) is buffered through `text()` instead and never raises this code. Check the `fetch` override passed to the client or the `httpStream` call.",
    ],
    LOCAL_DEPENDENCY_MISSING: [
        "The command Lunora tried to run is not on your PATH, so nothing ran.",
        "",
        "Install it (or put it on PATH) and retry — `wrangler` ships as a dependency of a Lunora app, so `pnpm install` usually fixes that one; `git` and `docker` are installed separately.",
    ],
};

/**
 * The catalog hint for `code`, or `undefined` when it has none. `Object.hasOwn`
 * for the same reason as `getCatalogEntry`: a bracket read of `"constructor"`
 * would return `Object.prototype`'s member.
 */
const getCatalogHint = (code: string): ErrorHint | undefined =>
    Object.hasOwn(ERROR_HINTS, code) ? (ERROR_HINTS as Record<string, ErrorHint>)[code] : undefined;

/**
 * A message-matched solution for errors that reach a consumer without a `code`
 * — chiefly `@lunora/codegen` build errors, which are thrown as plain messages
 * into generated code (and flattened to `{ message }` by the Vite overlay), so
 * the message text is the only stable join key. Ordered most- to least-specific;
 * the first matching rule wins.
 */
interface Solution {
    /** Markdown body shown under the header. */
    body: string;
    /** Short header for the solution. */
    header: string;
    /** Stable id (used in DEBUG logs and tests). */
    id: string;
}

/** A {@link Solution} plus its message matcher. */
interface SolutionRule extends Solution {
    /** True when this rule recognizes the error message. */
    test: (message: string) => boolean;
}

/**
 * Message-matched solutions (migrated verbatim from the former
 * `@lunora/codegen` solutions table). Re-exported by `@lunora/codegen` as
 * `LUNORA_SOLUTION_RULES` for backward compatibility.
 */
const MESSAGE_SOLUTIONS: ReadonlyArray<SolutionRule> = [
    {
        body: [
            "A single row exceeded the storage engine's per-row ceiling — 2 MB on a Durable Object's SQLite, and 2,000,000 bytes on D1.",
            "",
            "The limit is on the STORED bytes, which are UTF-8: a document of multi-byte text (CJK, emoji) costs up to 3x its character count. `v.bytes()` and `v.bigint()` columns cost more again on a shard-local table, where the row stores both a SQL-comparable projection and the original.",
            "",
            "Keep the large payload out of the row and store a reference to it:",
            "",
            "```ts",
            // eslint-disable-next-line no-template-curly-in-string -- markdown code sample shown to the developer, not a template literal
            "const key = `uploads/${crypto.randomUUID()}`;",
            "await ctx.storage.uploads.put(key, bytes);",
            'await ctx.db.insert("documents", { storageKey: key, title });',
            "```",
            "",
            "R2 has no practical object-size ceiling, and the row stays small enough to read, index, and replicate.",
        ].join("\n"),
        header: "Row too large for the storage engine",
        id: "lunora-row-too-big",
        test: (message) => ROW_TOO_BIG_RE.test(message),
    },
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
            "Rename the table to anything that isn't a `ctx.db` member (the error names the one it hit) — e.g. `userAccounts` instead of `insert`, or `pageViews` instead of `count`.",
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
        // Deliberately NOT ERROR_HINTS.NOT_UNIQUE: that code (and hint)
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
        body: CONFLICT_HINT.join("\n"),
        header: "Optimistic concurrency conflict",
        id: "lunora-runtime-occ",
        test: (message) => message.includes("optimistic concurrency conflict"),
    },
];

/**
 * One documented Cloudflare **platform** error — an edge/origin (5xx) or
 * Cloudflare-service (1xxx) failure surfaced in an error *message* rather than
 * thrown by Lunora as a coded `LunoraError`. These reach a Lunora app as
 * plain text: a Worker that fetches a Cloudflare-fronted origin sees `Error 522`,
 * a deploy that throws surfaces as `Error 1101`, and so on. The fields are the
 * curated facts a grounded explainer elaborates on — never invents beyond.
 */
interface CloudflarePlatformError {
    /** Documented likely causes (a short, comma-joined clause). */
    causes: string;
    /** The numeric Cloudflare error code, as it appears in the message (e.g. `"522"`, `"1101"`). */
    code: string;
    /** Canonical Cloudflare support-docs URL for this error's family. */
    docsUrl: string;
    /** Which docs family the code belongs to — shown in the "see docs" line. */
    family: "1xxx" | "5xx";
    /** The documented remediation. */
    fix: string;
    /** One-line summary of what the code means. */
    summary: string;
    /** Cloudflare's short name for the code (e.g. `"Connection timed out"`). */
    title: string;
}

/**
 * The curated Cloudflare platform-error table. Sourced from Cloudflare's official
 * support docs — the codes surfaced to app authors on Workers/DO deployments (the
 * origin-connection 52x family and the Worker/DNS/security 1xxx family). `1101`
 * (a Worker threw) and `1102` (a Worker exceeded CPU) are the most Lunora-relevant.
 */
const CLOUDFLARE_PLATFORM_ERRORS: ReadonlyArray<CloudflarePlatformError> = [
    {
        causes: "the origin returned an empty, unknown, or malformed response Cloudflare couldn't interpret (often an origin crash or an oversized response header)",
        code: "520",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "check your origin's logs for a crash, ensure it returns a valid HTTP response, and keep response headers under the size limit",
        summary: "Cloudflare got an unknown/empty response from your origin web server.",
        title: "Web server returns an unknown error",
    },
    {
        causes: "the origin refused the connection — the web server is down, or a firewall is blocking Cloudflare's IP ranges",
        code: "521",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "confirm the origin process is running and allowlist Cloudflare's published IP ranges in your firewall/security groups",
        summary: "Cloudflare could not connect to your origin because it refused the connection.",
        title: "Web server is down",
    },
    {
        causes: "Cloudflare could not establish a TCP connection to the origin in time — the origin is overloaded, a firewall is dropping packets, or the origin IP is wrong",
        code: "522",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "verify the origin is reachable and not overloaded, and that the DNS record points at the correct origin IP",
        summary: "The connection to your origin timed out before it was established.",
        title: "Connection timed out",
    },
    {
        causes: "Cloudflare cannot route to the origin at all — a bad DNS record, an origin IP that changed, or invalid routing",
        code: "523",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "verify the DNS A/AAAA record points at a reachable origin IP and that no upstream network is blocking Cloudflare",
        summary: "Cloudflare could not reach your origin server.",
        title: "Origin is unreachable",
    },
    {
        causes: "Cloudflare made a TCP connection but the origin did not return an HTTP response within 100 seconds — a slow handler or long-running request",
        code: "524",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "speed up the slow origin handler, or move long work off the request path into a background job (a Durable Object, Queue, or Workflow)",
        summary: "Cloudflare connected to your origin but it did not respond in time.",
        title: "A timeout occurred",
    },
    {
        causes: "the TLS handshake between Cloudflare and the origin failed — a missing/invalid origin certificate, or a cipher/SNI mismatch under Full (Strict) SSL",
        code: "525",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "install a valid certificate on the origin and align your Cloudflare SSL/TLS mode with the origin's certificate setup",
        summary: "The SSL handshake with your origin failed.",
        title: "SSL handshake failed",
    },
    {
        causes: "Cloudflare could not validate the origin's certificate under Full (Strict) SSL — it is expired, self-signed, or issued for the wrong hostname",
        code: "526",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "install a valid, publicly-trusted certificate on the origin (or use a Cloudflare Origin CA cert), matching the request hostname",
        summary: "Cloudflare could not validate your origin's SSL certificate.",
        title: "Invalid SSL certificate",
    },
    {
        causes: "a DNS record points at a Cloudflare IP or another prohibited address instead of your real origin",
        code: "1000",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "point the DNS record at your real origin IP, not a Cloudflare-owned or loopback address",
        summary: "DNS points to a prohibited IP.",
        title: "DNS points to prohibited IP",
    },
    {
        causes: "Cloudflare could not resolve the requested hostname — a Worker fetched an unresolvable host, or a DNS record is misconfigured",
        code: "1001",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "check the hostname you're requesting and the DNS records for the zone resolve to a valid origin",
        summary: "Cloudflare could not resolve the origin DNS.",
        title: "DNS resolution error",
    },
    {
        causes: "a Worker or DNS record targets a restricted IP (for example a Cloudflare-owned or loopback address)",
        code: "1002",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "change the Worker fetch target or DNS record to a valid, non-restricted origin address",
        summary: "DNS points to a prohibited IP (Worker/restricted).",
        title: "DNS points to a prohibited IP",
    },
    {
        causes: "the visitor's IP was blocked by an IP Access Rule, WAF rule, or security configuration on the zone",
        code: "1006",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "review the zone's Firewall/WAF and IP Access Rules to see why the address was banned, and adjust if it was blocked in error",
        summary: "Access denied: the visitor's IP has been banned.",
        title: "Access denied: your IP has been banned",
    },
    {
        causes: "your Worker threw an unhandled JavaScript exception during the request",
        code: "1101",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "reproduce with `wrangler tail` (or the Workers Logs / Studio Logs panel) to get the stack trace, then handle the throwing code path",
        summary: "A Worker threw a JavaScript exception.",
        title: "Worker threw a JavaScript exception",
    },
    {
        causes: "the Worker used more CPU time than a single invocation is allowed — usually a hot loop or heavy synchronous work",
        code: "1102",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "reduce per-request CPU (optimize hot loops, avoid heavy synchronous work) or offload the heavy work to a Durable Object, Queue, or Workflow",
        summary: "A Worker exceeded its CPU-time resource limit.",
        title: "Worker exceeded resource limits",
    },
];

/** True when `character` is an ASCII digit — the token boundary both matchers below test. */
const isDigit = (character: string | undefined): boolean => character !== undefined && character >= "0" && character <= "9";

/**
 * True when `code` appears in `haystack` as a standalone numeric token (not part
 * of a longer number like `5200` or a version `1.1011`). A boundary-checked
 * `indexOf` scan rather than a `RegExp` so no per-code pattern is constructed
 * from a (here trusted, but conventionally avoided) dynamic string.
 */
const hasStandaloneNumber = (haystack: string, code: string): boolean => {
    for (let from = haystack.indexOf(code); from !== -1; from = haystack.indexOf(code, from + code.length)) {
        if (!isDigit(haystack[from - 1]) && !isDigit(haystack[from + code.length])) {
            return true;
        }
    }

    return false;
};

/**
 * True when `haystack` carries Cloudflare's own `Error <code>` / `Error: <code>`
 * phrasing for `code`, with `code` a whole token.
 *
 * The trailing-digit check matters as much here as in the loose matcher. Without
 * it a plain `includes` matches a longer number by prefix, and the two most common
 * socket errors in the wild collide with real Cloudflare codes: `"Error 10061:
 * connect ECONNREFUSED"` (WSAECONNREFUSED) resolved to `1006` — "your IP has been
 * banned" — and `"Error 10060"` (WSAETIMEDOUT) did the same. The wrong hint then
 * became the wrong grounding facts in the explainer prompt.
 */
const hasCodePhrase = (haystack: string, code: string): boolean => {
    for (const phrase of [`error ${code}`, `error: ${code}`]) {
        for (let from = haystack.indexOf(phrase); from !== -1; from = haystack.indexOf(phrase, from + phrase.length)) {
            if (!isDigit(haystack[from + phrase.length])) {
                return true;
            }
        }
    }

    return false;
};

/**
 * Pre-filter over the RAW message, matching what both passes below require. Its
 * only job is speed: it lets a non-matching message skip the `toLowerCase()`
 * allocation as well as the scans. This table is a fallback on `resolveHint`, so
 * the overwhelmingly common call is a message that matches nothing — scanning it
 * unconditionally regressed the `unmatched message (worst case)` benchmark ~1.7x.
 */
const CF_PLATFORM_PREFILTER = /error|cloudflare/iu;

/** Render one {@link CloudflarePlatformError} as the {@link Solution} the CLI and the Issue explainer ground in. */
const cloudflarePlatformSolution = (entry: CloudflarePlatformError): Solution => {
    return {
        body: [
            entry.summary,
            "",
            `**Likely cause:** ${entry.causes}.`,
            "",
            `**Fix:** ${entry.fix}.`,
            "",
            `See [Cloudflare's ${entry.family} error docs](${entry.docsUrl}).`,
        ].join("\n"),
        header: `Cloudflare Error ${entry.code}: ${entry.title}`,
        id: `cloudflare-error-${entry.code}`,
    };
};

/**
 * Recognize a Cloudflare platform-error {@link CloudflarePlatformError} in a raw
 * error message, conservatively: the message must carry Cloudflare's own
 * `Error <code>` phrasing, or mention `cloudflare` alongside the standalone
 * code. That keeps a bare number (`expected 520 items`) from false-matching a 5xx
 * code, at the cost of missing a context-free code — the safe trade for a
 * grounded hint. Returns the matched code's {@link Solution}, or `undefined`.
 *
 * Matching runs in two passes, strongest first: Cloudflare's own `Error <code>`
 * phrasing is unambiguous, so it must win over the weaker "mentions cloudflare
 * near some number" heuristic regardless of table order. A single pass let a weak
 * match on an earlier entry beat an explicit match on a later one — `"Cloudflare
 * Error 1102: exceeded after 524 ms"` resolved to 524, and that wrong grounded
 * fix is exactly what the explainer prompt is built from.
 */
const findCloudflarePlatformSolution = (message: string): Solution | undefined => {
    // A message carrying neither word cannot match any code — bail before both
    // the lowercasing and the per-entry scans.
    if (!CF_PLATFORM_PREFILTER.test(message)) {
        return undefined;
    }

    const lower = message.toLowerCase();
    const mentionsError = lower.includes("error");
    const mentionsCloudflare = lower.includes("cloudflare");

    // Pass 1 — Cloudflare's own `Error <code>` phrasing is unambiguous.
    if (mentionsError) {
        for (const entry of CLOUDFLARE_PLATFORM_ERRORS) {
            if (hasCodePhrase(lower, entry.code)) {
                return cloudflarePlatformSolution(entry);
            }
        }
    }

    // Pass 2 — the weaker "mentions cloudflare + a standalone code" heuristic.
    if (mentionsCloudflare) {
        for (const entry of CLOUDFLARE_PLATFORM_ERRORS) {
            if (hasStandaloneNumber(lower, entry.code)) {
                return cloudflarePlatformSolution(entry);
            }
        }
    }

    return undefined;
};

/**
 * Flatten a Markdown hint to plain text for a terminal / non-Markdown surface:
 * drop code-fence markers and strip inline `**bold**` / `` `code` `` emphasis.
 * Shared by the CLI renderer and the Studio `ErrorAlert` so the two can't drift.
 */
const flattenHint = (hint: ErrorHint): string =>
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
const findSolutionByMessage = (message: string): Solution | undefined => {
    for (const rule of MESSAGE_SOLUTIONS) {
        if (rule.test(message)) {
            return { body: rule.body, header: rule.header, id: rule.id };
        }
    }

    return undefined;
};

/**
 * Find a solution for `message` across BOTH Lunora's own rules and the curated
 * Cloudflare platform-error table — the lookup the Studio Issues panel and the
 * `explainIssue` grounding use.
 *
 * Deliberately separate from {@link findSolutionByMessage} rather than folded into
 * it. That function is on `resolveHint`, and therefore on `toErrorBody` — the
 * envelope builder for every failed request. Most `ERROR_CATALOG` entries
 * carry no `hint`, so folding the platform table in there meant an ordinary
 * `BAD_REQUEST` whose message merely mentioned "cloudflare" near a number shipped
 * zone-configuration guidance ("review the zone's Firewall/WAF and IP Access
 * Rules") to unauthenticated browsers. The same fold put the table on the CLI
 * renderer and the Vite overlay, and on `toErrorBody`'s hot path.
 *
 * Platform errors are operator-facing context for an already-persisted Issue, so
 * the operator-facing surfaces opt in here and the wire path stays Lunora-only.
 */
const findIssueSolution = (message: string): Solution | undefined => findSolutionByMessage(message) ?? findCloudflarePlatformSolution(message);

/**
 * Resolve an actionable hint for an error: prefer a hint carried on the error
 * (or its `code`'s {@link ERROR_HINTS} entry), then fall back to a message match. Returns
 * `undefined` when nothing recognizes it.
 */
// eslint-disable-next-line sonarjs/function-return-type -- ErrorHint is intentionally `string | string[]`
const resolveHint = (input: { code?: string; hint?: ErrorHint; message?: string } | string): ErrorHint | undefined => {
    if (typeof input === "string") {
        return findSolutionByMessage(input)?.body;
    }

    if (input.hint !== undefined) {
        return input.hint;
    }

    if (input.code !== undefined) {
        const hint = getCatalogHint(input.code);

        if (hint !== undefined) {
            return hint;
        }
    }

    return input.message === undefined ? undefined : findSolutionByMessage(input.message)?.body;
};

export type { CloudflarePlatformError, ErrorHint, Solution, SolutionRule };
export {
    CLOUDFLARE_PLATFORM_ERRORS,
    ERROR_HINTS,
    findCloudflarePlatformSolution,
    findIssueSolution,
    findSolutionByMessage,
    flattenHint,
    getCatalogHint,
    MESSAGE_SOLUTIONS,
    resolveHint,
};
