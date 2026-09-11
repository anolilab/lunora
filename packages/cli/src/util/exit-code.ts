/**
 * The CLI's exit-code taxonomy — the contract a CI step or an AI agent reads
 * instead of parsing English prose out of stderr.
 *
 * The classification is NOT invented here: `@lunora/errors`' `ERROR_CATALOG`
 * already assigns every `code` a transport `status`, so the table below maps
 * `status -> exit code` once and every catalogued error inherits its bucket for
 * free. {@link EXIT_CODE_BY_CODE} is the deliberate exception list, for the
 * handful of codes whose wire status is honest on the wire and misleading in a
 * terminal (a build-time codegen diagnostic is a `500` to a client and the
 * developer's own source being wrong to the CLI).
 *
 * Documented for users at `docs/reference/exit-codes`.
 */
import { getCatalogEntry, isLunoraError } from "@lunora/errors";

/**
 * Every exit code `lunora` can terminate with. Stable — a value never changes
 * meaning, and a new bucket takes the next free number.
 */
const EXIT_CODE = {
    /** The command did what was asked. */
    SUCCESS: 0,
    /** A failure that fits none of the narrower buckets. */
    FAILURE: 1,
    /** Bad usage, bad input, or a validation failure — the invocation itself, or the project source it read, is wrong. */
    USAGE: 2,
    /** Not authenticated: no credential, or an expired one. */
    AUTH: 3,
    /** Authenticated, but not allowed to do this. */
    PERMISSION: 4,
    /** The named thing does not exist. */
    NOT_FOUND: 5,
    /** The write lost a race, or the name is already taken. */
    CONFLICT: 6,
    /** Rate limited — back off and retry. */
    RATE_LIMITED: 7,
    /** The far side is unavailable or timed out. Retryable. */
    UNAVAILABLE: 8,
    /** A local tool the command shells out to (wrangler, git, docker, …) is not installed. */
    MISSING_DEPENDENCY: 9,
    /** Interactive cancel — the POSIX `128 + SIGINT` convention. */
    CANCELLED: 130,
} as const;

/** One of {@link EXIT_CODE}'s values. */
type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

/**
 * Transport `status` -> exit code. Anything absent (chiefly `500` / `501`) is a
 * general failure, which is the honest answer for an internal error.
 */
const EXIT_CODE_BY_STATUS: ReadonlyMap<number, ExitCode> = new Map<number, ExitCode>([
    [400, EXIT_CODE.USAGE],
    [401, EXIT_CODE.AUTH],
    [403, EXIT_CODE.PERMISSION],
    [404, EXIT_CODE.NOT_FOUND],
    [405, EXIT_CODE.USAGE],
    [409, EXIT_CODE.CONFLICT],
    [413, EXIT_CODE.USAGE],
    // 421 is the runtime's replica-routing verdict: the request reached a node
    // that could not serve it, which is the same "try again" shape as a 503.
    [421, EXIT_CODE.UNAVAILABLE],
    [422, EXIT_CODE.USAGE],
    [429, EXIT_CODE.RATE_LIMITED],
    [502, EXIT_CODE.UNAVAILABLE],
    [503, EXIT_CODE.UNAVAILABLE],
    [504, EXIT_CODE.UNAVAILABLE],
    // 507 is a CEILING, not a transient — and `UNAVAILABLE`'s contract tells
    // automation to retry. Every 507 this system raises reports that the thing
    // asked for is too big for the place it has to fit: `BACKUP_TOO_LARGE` (the
    // snapshot exceeds what a Worker isolate will assemble — its own hint says
    // "backing up more often does not help", the fix is `backupTables` or
    // `--bucket`) and `STREAM_TOO_LONG` (a durable stream past its chunk
    // ceiling). Both fail identically on every retry until a human narrows the
    // input, which is exit 2. A genuinely transient 507 added later belongs in
    // {@link EXIT_CODE_BY_CODE}, not here.
    [507, EXIT_CODE.USAGE],
]);

/**
 * The codes whose catalog `status` is ambiguous from a terminal. Alphabetical,
 * so it stays greppable as the table grows.
 *
 * Everything here except `LOCAL_DEPENDENCY_MISSING` is a build-time codegen
 * diagnostic: it is catalogued `500` because that is what it would be if it ever
 * crossed the wire (it never does), while what it actually reports is a mistake
 * in the developer's own `lunora/` source — which is exit 2, the same bucket a
 * bad flag lands in. `LOCAL_DEPENDENCY_MISSING` has no HTTP status that means
 * "the tool isn't installed", so it gets its own bucket here.
 */
const EXIT_CODE_BY_CODE: ReadonlyMap<string, ExitCode> = new Map<string, ExitCode>([
    ["CODEGEN_DIAGNOSTIC", EXIT_CODE.USAGE],
    ["CRON_EXPR_INVALID", EXIT_CODE.USAGE],
    ["CRON_EXPR_NOT_STATIC", EXIT_CODE.USAGE],
    ["CRON_NAME_NOT_STATIC", EXIT_CODE.USAGE],
    ["CRON_NON_STATIC_FN", EXIT_CODE.USAGE],
    ["CRON_NON_STATIC_VALUE", EXIT_CODE.USAGE],
    ["CRON_SCHEDULE_INVALID", EXIT_CODE.USAGE],
    ["CRON_SCHEDULE_NOT_STATIC", EXIT_CODE.USAGE],
    ["DUPLICATE_AGENT_BINDING", EXIT_CODE.USAGE],
    ["DUPLICATE_AGENT_CLASS", EXIT_CODE.USAGE],
    ["DUPLICATE_AGENT_NAME", EXIT_CODE.USAGE],
    ["DUPLICATE_CRON_NAME", EXIT_CODE.USAGE],
    ["DUPLICATE_MIGRATION_ID", EXIT_CODE.USAGE],
    ["DUPLICATE_QUEUE_BINDING", EXIT_CODE.USAGE],
    ["DUPLICATE_QUEUE_NAME", EXIT_CODE.USAGE],
    ["DUPLICATE_WORKFLOW_CLASS", EXIT_CODE.USAGE],
    ["LOCAL_DEPENDENCY_MISSING", EXIT_CODE.MISSING_DEPENDENCY],
    ["MIGRATION_ID_NOT_STATIC", EXIT_CODE.USAGE],
    ["NAMESPACE_COLLISION", EXIT_CODE.USAGE],
    ["SCHEMA_SNAPSHOT_PARSE", EXIT_CODE.USAGE],
]);

/** The exit code for a transport status; `undefined` and anything unmapped are a general failure. */
const exitCodeForStatus = (status: number | undefined): ExitCode =>
    status === undefined ? EXIT_CODE.FAILURE : (EXIT_CODE_BY_STATUS.get(status) ?? EXIT_CODE.FAILURE);

/**
 * The exit code for a Lunora error `code`, resolved through the catalog. An
 * unregistered code has no status to derive from, so it is a general failure.
 */
const exitCodeForCode = (code: string): ExitCode => EXIT_CODE_BY_CODE.get(code) ?? exitCodeForStatus(getCatalogEntry(code)?.status);

/**
 * The exit code for a thrown value. A Lunora error is classified by its `code`
 * (override table first) and then by the `status` the instance carries — which
 * is the catalog's, unless the throw site passed a more specific one (the
 * upstream-API codes do). Anything else is a general failure.
 */
const exitCodeForError = (error: unknown): ExitCode => {
    if (!isLunoraError(error)) {
        return EXIT_CODE.FAILURE;
    }

    return EXIT_CODE_BY_CODE.get(error.code) ?? exitCodeForStatus(error.status);
};

export type { ExitCode };
export { EXIT_CODE, exitCodeForCode, exitCodeForError, exitCodeForStatus };
