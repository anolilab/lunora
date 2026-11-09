/**
 * The SQL migration admin route, `POST /_lunora/admin/sql-migrations`. It runs the multi-statement files `lunora migrate
 * generate` writes (`DROP TABLE`, `DROP INDEX`, hand-written statements), which nothing else runs. The decisions
 * (drift, destructive confirmation, skipped `ADD COLUMN`s) live in `@lunora/d1`; this module only checks the request
 * and hands it over.
 *
 * Gated to the root token, or a named token minted with the `migrations` scope. A scoped caller runs additive statements
 * only: a file can drop a table or rewrite auth or role rows, and only the root token may do that.
 */
import { readJsonBodyWithLimit } from "./body-readers";
import { LunoraError } from "./errors";
import { methodGuard } from "./method-guard";

const SQL_MIGRATIONS_PATH = "/_lunora/admin/sql-migrations";

/**
 * A generated file can carry many statements; the default 1 MiB request cap is too small for a large schema. Enforced
 * twice: the reader's cap, and the entry point's `Content-Length` pre-check, which reads `ROUTE_BODY_BUDGETS` in
 * `create-worker.ts` and would otherwise reject the request before the reader runs.
 */
const SQL_MIGRATION_BODY_BYTES: number = 8 * 1_048_576;

/** One file the CLI sends: its name under `lunora/migrations/` and its SQL text. */
interface SqlMigrationFileRequest {
    name: string;
    sql: string;
}

interface SqlMigrationApplyRequest {
    /** Run only additive statements (a new table or index, an added column). Set by the route from the caller's token, never by the body. */
    additiveOnly: boolean;
    /** Record every pending file as applied without running it. Drift is still refused. */
    baseline: boolean;
    /** Record pending files up to and including this one (by name), and leave the later ones pending. */
    baselineThrough?: string;
    /** Run files that hold destructive statements. Without it such a file is refused and nothing runs. */
    confirmDestructive: boolean;
    /** Report the plan without running or recording anything. */
    dryRun: boolean;
    files: ReadonlyArray<SqlMigrationFileRequest>;
}

/** The per-file outcome, as `@lunora/d1`'s `applySqlMigrationFiles` reports it. */
interface SqlMigrationApplyResult {
    files: ReadonlyArray<{
        destructive: ReadonlyArray<string>;
        name: string;
        rootOnly: ReadonlyArray<string>;
        skipped: ReadonlyArray<string>;
        state: "applied" | "baselined" | "changed" | "pending" | "ran";
        statements: ReadonlyArray<string>;
    }>;
    /** A dry run only: the pending files a real run with the same options would refuse. */
    refused?: ReadonlyArray<string>;
}

/** The worker option that runs a request against the D1 binding; absent when the worker has no D1 global plane. */
type SqlMigrationApplier = (request: SqlMigrationApplyRequest) => Promise<SqlMigrationApplyResult>;

interface SqlMigrationAdminRouteDeps {
    /** Runs the files against the worker's D1 binding; absent when there is no D1 global plane (e.g. Hyperdrive-only). */
    applySqlMigrations?: SqlMigrationApplier;
    /** Enforce the route's gate: the root token, or a named token with the `migrations` scope. */
    assertAdmin: (request: Request) => void;
    /** Whether the caller holds the root token. A scoped caller's run is additive-only. */
    isRootAdmin: (request: Request) => boolean;
}

/** Reads the `files` array, rejecting anything that is not a named SQL text. */
const parseFiles = (raw: unknown): SqlMigrationFileRequest[] => {
    if (!Array.isArray(raw)) {
        throw new LunoraError("SQL migration request `files` must be an array", { code: "BAD_REQUEST", status: 400 });
    }

    return raw.map((entry: unknown) => {
        const file = entry as { name?: unknown; sql?: unknown } | null;

        if (file === null || typeof file !== "object" || typeof file.name !== "string" || typeof file.sql !== "string") {
            throw new LunoraError("each SQL migration file needs a string `name` and a string `sql`", { code: "BAD_REQUEST", status: 400 });
        }

        return { name: file.name, sql: file.sql };
    });
};

/** The optional `baselineThrough` file name: absent is `undefined`, anything but a string is refused. */
const baselineThroughName = (body: Record<string, unknown>): string | undefined => {
    const value = body["baselineThrough"];

    if (value !== undefined && typeof value !== "string") {
        throw new LunoraError("SQL migration `baselineThrough` must be a file name", { code: "BAD_REQUEST", status: 400 });
    }

    return value;
};

/** An optional boolean flag from the request body: absent is `false`, anything but a boolean is refused. */
const flag = (body: Record<string, unknown>, name: string): boolean => {
    if (body[name] !== undefined && typeof body[name] !== "boolean") {
        throw new LunoraError(`SQL migration \`${name}\` must be a boolean`, { code: "BAD_REQUEST", status: 400 });
    }

    return body[name] === true;
};

const buildSqlMigrationAdminRoutes = (deps: SqlMigrationAdminRouteDeps): Record<string, (request: Request) => Promise<Response>> => {
    const handleSqlMigrations = async (request: Request): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["POST"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        deps.assertAdmin(request);

        const apply = deps.applySqlMigrations;

        if (apply === undefined) {
            throw new LunoraError("SQL migrations run against the D1 global plane, and this worker has none to run them on", {
                code: "SQL_MIGRATIONS_NOT_CONFIGURED",
                status: 400,
            });
        }

        const body = await readJsonBodyWithLimit(request, SQL_MIGRATION_BODY_BYTES);

        const through = baselineThroughName(body);
        const result = await apply({
            additiveOnly: !deps.isRootAdmin(request),
            baseline: flag(body, "baseline"),
            ...(through === undefined ? {} : { baselineThrough: through }),
            confirmDestructive: flag(body, "confirmDestructive"),
            dryRun: flag(body, "dryRun"),
            files: parseFiles(body["files"]),
        });

        return Response.json(result, { headers: { "cache-control": "no-store" } });
    };

    return { [SQL_MIGRATIONS_PATH]: handleSqlMigrations };
};

export type { SqlMigrationApplier, SqlMigrationApplyRequest, SqlMigrationApplyResult, SqlMigrationFileRequest };
export { buildSqlMigrationAdminRoutes, SQL_MIGRATION_BODY_BYTES, SQL_MIGRATIONS_PATH };
