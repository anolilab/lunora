/**
 * The `/_lunora/admin/logs/archive` route, backing the studio Logs panel's
 * **Archive** feed. It reads the durable `ctx.log` archive that `pipelineLogSink`
 * writes to R2 (an Iceberg table in R2 Data Catalog) back via R2 SQL, using
 * {@link createPipelineLogReader} — the exact same reader the `lunora logs
 * --durable` CLI uses.
 *
 * This MUST run server-side: R2 SQL needs a Cloudflare API token, which must
 * never reach the browser. The studio calls this admin route (gated by
 * `LUNORA_ADMIN_TOKEN`); only the decoded `{ rows, nextCursor }` page crosses to
 * the client. Credentials come from the worker `env` (`R2_SQL_*`), the target
 * Data Catalog table from the app's `logArchive` worker option — mirroring how
 * the CLI splits env creds from the `--table` flag.
 *
 * Fail-closed: when the operator has wired no archive table (`logArchive`
 * absent) OR the R2 SQL credentials are missing, every call returns a single
 * `LOG_ARCHIVE_NOT_CONFIGURED` (400) — one signal the panel renders as a
 * "not configured, see docs" empty state rather than an error.
 */
import { createR2Sql } from "@lunora/bindings/r2sql";

import type { ContextLogLevel } from "../../../shared/log-event";
import { LOG_LEVEL_ORDER } from "../../../shared/log-event";
import { LunoraError } from "./errors";
import type { PipelineLogColumnMap, PipelineLogPage, PipelineLogQuery } from "./pipeline-log-reader";
import { createPipelineLogReader } from "./pipeline-log-reader";

/** The route the studio's `queryLogArchive` client method POSTs to. */
const LOG_ARCHIVE_PATH = "/_lunora/admin/logs/archive";

/** The `NOT_CONFIGURED` error code shared by the "no table" and "no creds" fail-closed paths. */
const LOG_ARCHIVE_NOT_CONFIGURED = "LOG_ARCHIVE_NOT_CONFIGURED";

/**
 * The app-level archive config the worker passes through: which Data Catalog
 * table the Pipeline writes log records to (the read-side of `pipelineLogSink`),
 * plus optional namespace / physical-column overrides. The R2 SQL *credentials*
 * are NOT here — they live on `env` (`R2_SQL_*`), read per request.
 */
interface LogArchiveConfig {
    /** Override any physical column name that diverges from the {@link createPipelineLogReader} default mapping. */
    columnMap?: PipelineLogColumnMap;
    /** The Iceberg namespace (R2 Data Catalog database) the table lives in; omit when `table` already carries it. */
    namespace?: string;
    /** The Iceberg table the Pipeline writes log records to (e.g. `"logs"`). */
    table: string;
}

/** The subset of worker `env` this route reads — the R2 SQL REST credentials. */
interface LogArchiveEnvironment {
    /** Fallback account id, honoured when `R2_SQL_ACCOUNT_ID` is unset (matches `ctx.r2sql`). */
    CLOUDFLARE_ACCOUNT_ID?: string;
    R2_SQL_ACCOUNT_ID?: string;
    R2_SQL_BUCKET?: string;
    R2_SQL_TOKEN?: string;
}

/** The worker internals the route reaches through injection rather than closure. */
interface LogArchiveAdminRouteDeps {
    /** Test seam: the reader factory, defaulting to the real {@link createPipelineLogReader}. */
    createReader?: typeof createPipelineLogReader;
    /** The app's archive config off `WorkerOptions`; absent → fail-closed. */
    logArchive?: LogArchiveConfig;
    /** Read + parse the JSON request body under the runtime's size limit. */
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
    /** Admin-gate + require a configured option, else throw the `*_NOT_CONFIGURED` error. */
    requireAdminOption: <T>(request: Request, value: T | undefined, notConfigured: { code: string; message: string }) => T;
}

/** The known severities, for validating the `level`/`minLevel` filters (mirrors the CLI's `parseLevel`). */
const LOG_LEVELS: ReadonlySet<string> = new Set<string>(LOG_LEVEL_ORDER);

/** Narrow a body value to a non-empty string, else `undefined`. */
const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Validate an optional severity filter against the known level set, else 400. */
const parseLevel = (value: unknown, field: string): ContextLogLevel | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string" || !LOG_LEVELS.has(value)) {
        throw new LunoraError(`logs archive: invalid \`${field}\` — expected one of ${LOG_LEVEL_ORDER.join(", ")}`, { code: "BAD_REQUEST", status: 400 });
    }

    return value as ContextLogLevel;
};

/** Validate an optional finite-number filter (timestamps, limit), else 400. */
const parseFiniteNumber = (value: unknown, field: string): number | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new LunoraError(`logs archive: invalid \`${field}\` — expected a finite number`, { code: "BAD_REQUEST", status: 400 });
    }

    return value;
};

/** Build a validated {@link PipelineLogQuery} from the raw admin request body. */
const parseQuery = (body: Record<string, unknown>): PipelineLogQuery => {
    const query: PipelineLogQuery = {};

    const assignString = (field: "functionPath" | "functionPathPrefix" | "shardKey" | "traceId" | "userId"): void => {
        const value = optionalString(body[field]);

        if (value !== undefined) {
            query[field] = value;
        }
    };

    assignString("functionPath");
    assignString("functionPathPrefix");
    assignString("traceId");
    assignString("shardKey");
    assignString("userId");

    const level = parseLevel(body["level"], "level");

    if (level !== undefined) {
        query.level = level;
    }

    const minLevel = parseLevel(body["minLevel"], "minLevel");

    if (minLevel !== undefined) {
        query.minLevel = minLevel;
    }

    const sinceTs = parseFiniteNumber(body["sinceTs"], "sinceTs");

    if (sinceTs !== undefined) {
        query.sinceTs = sinceTs;
    }

    const untilTs = parseFiniteNumber(body["untilTs"], "untilTs");

    if (untilTs !== undefined) {
        query.untilTs = untilTs;
    }

    const limit = parseFiniteNumber(body["limit"], "limit");

    if (limit !== undefined) {
        query.limit = limit;
    }

    // The cursor is `{ ts }`; accept it as an object and validate the `ts`.
    const rawCursor = body["cursor"];

    if (typeof rawCursor === "object" && rawCursor !== null) {
        const cursorTs = parseFiniteNumber((rawCursor as Record<string, unknown>)["ts"], "cursor.ts");

        if (cursorTs !== undefined) {
            query.cursor = { ts: cursorTs };
        }
    }

    return query;
};

/**
 * Resolve the R2 SQL account id / token / bucket off `env`, or throw a single
 * fail-closed {@link LOG_ARCHIVE_NOT_CONFIGURED} naming exactly what's missing
 * (mirrors the CLI's `missing.push(...)` message).
 */
const resolveCredentials = (environment: LogArchiveEnvironment): { accountId: string; apiToken: string; bucket: string } => {
    const accountId = environment.R2_SQL_ACCOUNT_ID ?? environment.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = environment.R2_SQL_TOKEN;
    const bucket = environment.R2_SQL_BUCKET;
    const missing: string[] = [];

    if (accountId === undefined || accountId === "") {
        missing.push("R2_SQL_ACCOUNT_ID");
    }

    if (apiToken === undefined || apiToken === "") {
        missing.push("R2_SQL_TOKEN");
    }

    if (bucket === undefined || bucket === "") {
        missing.push("R2_SQL_BUCKET");
    }

    if (missing.length > 0) {
        throw new LunoraError(
            `log archive not configured (missing ${missing.join(", ")}). The Pipeline must write to an R2 Data Catalog (Iceberg) table, and R2_SQL_ACCOUNT_ID / R2_SQL_TOKEN / R2_SQL_BUCKET must be set — see the observability docs.`,
            { code: LOG_ARCHIVE_NOT_CONFIGURED, status: 400 },
        );
    }

    return { accountId: accountId as string, apiToken: apiToken as string, bucket: bucket as string };
};

/** Build the `/_lunora/admin/logs/archive` route, merged into the worker's internal route table. */
const buildLogArchiveAdminRoutes = (deps: LogArchiveAdminRouteDeps): Record<string, (request: Request, env: unknown) => Promise<Response>> => {
    const { createReader = createPipelineLogReader, readJsonBody, requireAdminOption } = deps;

    const handleLogArchive = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new LunoraError("Log-archive endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        // Admin-gate + require the app to have wired an archive table.
        const config = requireAdminOption(request, deps.logArchive, {
            code: LOG_ARCHIVE_NOT_CONFIGURED,
            message: "log archive requires a `logArchive` config (an R2 Data Catalog table) on the worker — see the observability docs",
        });

        const { accountId, apiToken, bucket } = resolveCredentials(env ?? {});
        const query = parseQuery(await readJsonBody(request));

        const client = createR2Sql({ accountId, apiToken, bucket });
        const reader = createReader(client, { columnMap: config.columnMap, namespace: config.namespace, table: config.table });
        const page: PipelineLogPage = await reader.query(query);

        return Response.json(page, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return { [LOG_ARCHIVE_PATH]: handleLogArchive };
};

export type { LogArchiveAdminRouteDeps, LogArchiveConfig };
export { buildLogArchiveAdminRoutes, LOG_ARCHIVE_NOT_CONFIGURED, LOG_ARCHIVE_PATH };
