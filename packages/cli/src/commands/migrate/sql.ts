/**
 * `lunora migrate apply` and `migrate status --sql`: the generated SQL migration files under `lunora/migrations/`,
 * sent to the Worker's `/_lunora/admin/sql-migrations` route. The decisions (drift, destructive confirmation, skipped
 * `ADD COLUMN`s, the fresh-database rule) live in `@lunora/d1`. This module checks the target, sends the files, and
 * reads the reply.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { join } from "@visulima/path";

import { resolveAdminBearer, targetsRemoteWorker } from "../../util/admin-token";
import { adminFetch, resolveAdminBaseUrl } from "../../util/admin-url";
import { EXIT_CODE, exitCodeForStatus } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { FetchLike } from "../run/handler";

/** The Worker route `migrate apply` posts the generated SQL files to; mirrors `SQL_MIGRATIONS_PATH` in `@lunora/runtime`. */
const SQL_MIGRATIONS_PATH = "/_lunora/admin/sql-migrations";

type MigrateSqlFileState = "applied" | "baselined" | "changed" | "pending" | "ran";

/** The states a file is in once a run has recorded it, or applied it. Anything else after a run is incomplete. */
const RECORDED_STATES: ReadonlySet<string> = new Set<MigrateSqlFileState>(["applied", "baselined", "ran"]);
const FILE_STATES: ReadonlySet<string> = new Set<MigrateSqlFileState>(["applied", "baselined", "changed", "pending", "ran"]);

/** What the Worker reports for one SQL file: what it did, or would do, and why a statement was left out. */
interface MigrateSqlFilePlan {
    destructive: string[];
    name: string;
    /** Statements a migrations-scoped token may not run. Absent from a reply that predates the scope. */
    rootOnly?: string[];
    skipped: string[];
    state: MigrateSqlFileState;
    statements: string[];
}

interface MigrateSqlCommandOptions {
    /** Record the pending files as applied without running them (`migrate apply --baseline`). */
    baseline?: boolean;
    /** Record the pending files up to and including this one, by name; the later ones stay pending. */
    baselineThrough?: string;
    cwd?: string;
    /** Report each file's state and statements without running anything (`migrate status --sql`). */
    dryRun?: boolean;
    fetchImpl?: FetchLike;
    logger: Logger;
    /** Guard: refuse to target the implicit localhost worker. */
    prod?: boolean;
    /** Admin bearer token; falls back to `LUNORA_ADMIN_TOKEN`. */
    token?: string;
    /** Worker URL (default `http://localhost:8787`). */
    url?: string;
    /** Confirms a run against a non-local worker, and a file that drops or replaces data. */
    yes?: boolean;
}

interface MigrateSqlCommandResult {
    code: number;
    /** Why it failed, when the reason is known. */
    error?: string;
    /** The Worker's per-file outcome. Empty when nothing was sent. */
    files: MigrateSqlFilePlan[];
}

/** The SQL files under `lunora/migrations/`, in name order, which is timestamp order for generated files. */
const readSqlMigrationFiles = (cwd: string): { name: string; sql: string }[] => {
    const directory = join(cwd, "lunora", "migrations");

    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .toSorted((left, right) => left.localeCompare(right))
        .map((name) => {
            return { name, sql: readFileSync(join(directory, name), "utf8") };
        });
};

/** One line per file, and with a dry run each of its statements. */
const logSqlFilePlan = (logger: Logger, file: MigrateSqlFilePlan, dryRun: boolean): void => {
    const skipped = file.skipped.length > 0 ? `, ${String(file.skipped.length)} already in place` : "";

    logger.info(`${file.state.padEnd(9)} ${file.name} (${String(file.statements.length)} statement(s)${skipped})`);

    if (dryRun) {
        for (const statement of file.statements) {
            logger.info(`    ${statement.split("\n").join("\n    ")}`);
        }
    }

    if ((file.rootOnly?.length ?? 0) > 0 && file.state === "pending") {
        logger.warn(`${file.name} runs statements a migrations-scoped token may not run; it needs the root admin token.`);
    }

    if (file.destructive.length > 0 && file.state === "pending") {
        logger.warn(`${file.name} drops, renames, truncates or replaces data. It runs only with --yes.`);
    }
};

/** The reply's body as parsed JSON, or the raw text when it is not JSON (a proxy's HTML page, say). */
const readReply = async (response: { text: () => Promise<string> }): Promise<unknown> => {
    const text = await response.text();

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
};

/** The `error.code` of a Worker error reply, or `undefined` for any other body. */
const replyErrorCode = (body: unknown): string | undefined => {
    const code = (body as { error?: { code?: unknown } } | null | undefined)?.error?.code;

    return typeof code === "string" ? code : undefined;
};

/** The verb the log line and the error messages use for this run. */
const runVerb = (dryRun: boolean, recordOnly: boolean): string => {
    if (dryRun) {
        return "plan";
    }

    return recordOnly ? "baseline" : "apply";
};

/**
 * The admin target for the request, or the refusal that stops it before anything is sent. A remote target needs
 * `--yes` for a run that writes; a dry run writes nothing and needs no confirmation.
 */
const resolveSqlTarget = (options: MigrateSqlCommandOptions, cwd: string, dryRun: boolean): { baseUrl: string; token: string } | MigrateSqlCommandResult => {
    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return { code: EXIT_CODE.USAGE, files: [] };
    }

    const { token } = resolveAdminBearer({ cwd, token: options.token, url: baseUrl });

    if (!token) {
        const error = "admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)";

        options.logger.error(error);

        return { code: EXIT_CODE.AUTH, error, files: [] };
    }

    if (!dryRun && targetsRemoteWorker({ prod: options.prod, url: baseUrl }) && !options.yes) {
        const error = `migrate apply runs the SQL migrations against ${baseUrl}, which is not local. Re-run with --yes to confirm.`;

        options.logger.error(error);

        return { code: EXIT_CODE.USAGE, error, files: [] };
    }

    return { baseUrl, token };
};

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** One reply entry with every field the CLI reads, checked rather than trusted from a cast. */
const isFilePlan = (value: unknown): value is MigrateSqlFilePlan => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const entry = value as Record<string, unknown>;

    return (
        typeof entry["name"] === "string" &&
        typeof entry["state"] === "string" &&
        FILE_STATES.has(entry["state"]) &&
        isStringArray(entry["destructive"]) &&
        isStringArray(entry["skipped"]) &&
        isStringArray(entry["statements"])
    );
};

/**
 * The per-file plans from a 200 reply, or `undefined` when the reply does not name every file that was sent, exactly
 * once, with the fields the CLI reads. A 200 is not proof the worker ran anything: a proxy or an SPA fallback can
 * answer any path with a success, and a name-only entry would fail later in logging.
 */
/** The files a dry run says a real run would refuse. A reply without the list, from a worker that predates it, reads as none. */
const refusedFromReply = (body: unknown): string[] => {
    const refused: unknown = (body as { refused?: unknown } | null | undefined)?.refused;

    return Array.isArray(refused) && refused.every((name) => typeof name === "string") ? refused : [];
};

const plansFromReply = (body: unknown, files: ReadonlyArray<{ name: string }>): MigrateSqlFilePlan[] | undefined => {
    const reported: unknown = (body as { files?: unknown } | null | undefined)?.files;

    if (!Array.isArray(reported) || !reported.every(isFilePlan)) {
        return undefined;
    }

    const names = reported.map((plan) => plan.name);
    const sent = files.map((file) => file.name);
    const namesEachFileOnce = new Set(names).size === names.length && names.length === sent.length && sent.every((name) => names.includes(name));

    return namesEachFileOnce ? reported : undefined;
};

/**
 * The files a run must bring to a recorded state. With `--baseline-through` only the files up to that name; the later
 * ones are meant to stay pending, so a later apply can run them.
 */
const requiredFileNames = (files: ReadonlyArray<{ name: string }>, baselineThrough: string | undefined): Set<string> => {
    const through = baselineThrough === undefined ? files.length - 1 : files.findIndex((file) => file.name === baselineThrough);

    return new Set(files.slice(0, through + 1).map((file) => file.name));
};

/** The refusal for a run that cannot go ahead: logged, and returned with its exit code. */
const refuse = (logger: Logger, error: string, code: number): MigrateSqlCommandResult => {
    logger.error(error);

    return { code, error, files: [] };
};

/** The usage refusal for flags that cannot be combined, or a `--baseline-through` that names no file. */
const argumentRefusal = (options: MigrateSqlCommandOptions, files: ReadonlyArray<{ name: string }>): MigrateSqlCommandResult | undefined => {
    const { baselineThrough } = options;

    if (options.baseline === true && baselineThrough !== undefined) {
        return refuse(options.logger, "pass either --baseline or --baseline-through, not both", EXIT_CODE.USAGE);
    }

    if (baselineThrough !== undefined && !files.some((file) => file.name === baselineThrough)) {
        return refuse(options.logger, `--baseline-through ${baselineThrough} names no file under lunora/migrations/`, EXIT_CODE.USAGE);
    }

    return undefined;
};

/**
 * The refusal for a reply that is not a per-file result, or `undefined` when the reply should be read as one. A 400 for
 * a worker with no D1 plane is a skip, not a refusal: that worker has nothing for the files to run against.
 */
const replyRefusal = (
    response: { ok: boolean; status: number },
    body: unknown,
    target: { baseUrl: string },
    logger: Logger,
): MigrateSqlCommandResult | undefined => {
    if (response.status === 404) {
        return refuse(
            logger,
            `the worker at ${target.baseUrl} has no ${SQL_MIGRATIONS_PATH} route, so it predates \`migrate apply\`. Deploy a version of lunora that includes it, then re-run.`,
            EXIT_CODE.NOT_FOUND,
        );
    }

    if (response.status === 413) {
        return refuse(
            logger,
            `${target.baseUrl} refused the request: the SQL files in lunora/migrations/ together exceed the 8 MiB one request can carry. Split the files across deploys.`,
            exitCodeForStatus(response.status),
        );
    }

    if (response.status === 400 && replyErrorCode(body) === "SQL_MIGRATIONS_NOT_CONFIGURED") {
        logger.warn(`${target.baseUrl} has no D1 global plane, so the SQL files in lunora/migrations/ do not run there. Skipping them.`);

        return { code: 0, files: [] };
    }

    // Refusals the worker names, said in terms of the fix rather than the raw reply.
    if (replyErrorCode(body) === "ADMIN_SCOPE_REQUIRED") {
        return refuse(
            logger,
            `${target.baseUrl} refused migrate apply: this token has no migrations scope. Mint one with \`lunora admin-token create <name> --scope migrations\` and pass it as --token.`,
            exitCodeForStatus(response.status),
        );
    }

    if (replyErrorCode(body) === "MIGRATION_ROOT_REQUIRED") {
        return refuse(
            logger,
            `${target.baseUrl} refused migrate apply: a file runs statements that a migrations-scoped token may not run (a DROP, a row write or a trigger). Run it with the root admin token; the dry run lists the statements.`,
            exitCodeForStatus(response.status),
        );
    }

    if (!response.ok) {
        // The reply is only printed when it failed: on success the per-file lines below say what happened.
        logger.info(JSON.stringify(body, undefined, 2));

        return refuse(
            logger,
            `migrate apply was refused by ${target.baseUrl} (HTTP ${String(response.status)}) — see the response above`,
            exitCodeForStatus(response.status),
        );
    }

    return undefined;
};

/**
 * The failure for a run that did not finish: a dry run that finds a file changed, or a real run that left a file it was
 * asked to reach unrecorded. `deploy --migrate` must not go on past either. A dry run changes nothing, so it has no
 * unrecorded files to report.
 */
const unfinishedRun = (
    plans: ReadonlyArray<MigrateSqlFilePlan>,
    files: ReadonlyArray<{ name: string }>,
    options: { baselineThrough: string | undefined; baseUrl: string; dryRun: boolean; logger: Logger; refused: ReadonlyArray<string> },
): MigrateSqlCommandResult | undefined => {
    if (options.dryRun) {
        const drifted = plans.filter((file) => file.state === "changed").map((file) => file.name);

        if (drifted.length > 0) {
            return refuse(options.logger, `${String(drifted.length)} SQL file(s) changed after they were applied: ${drifted.join(", ")}`, EXIT_CODE.CONFLICT);
        }

        // A plan the real run would refuse is a failed check too, so `status --sql` in CI catches it before the deploy.
        if (options.refused.length > 0) {
            return refuse(
                options.logger,
                `${String(options.refused.length)} SQL file(s) would be refused when applied: ${options.refused.join(", ")}. See the statements listed above.`,
                EXIT_CODE.CONFLICT,
            );
        }

        return undefined;
    }

    const required = requiredFileNames(files, options.baselineThrough);
    const incomplete = plans.filter((file) => required.has(file.name) && !RECORDED_STATES.has(file.state)).map((file) => file.name);

    if (incomplete.length === 0) {
        return undefined;
    }

    const verb = incomplete.length === 1 ? "was" : "were";

    return refuse(options.logger, `${incomplete.join(", ")} ${verb} not recorded by ${options.baseUrl}, so the run did not finish`, EXIT_CODE.FAILURE);
};

/**
 * `lunora migrate apply`, `migrate apply --baseline` and `migrate status --sql`: send the SQL files to the Worker, which
 * runs the pending ones, records them, or (on a dry run) reports them. The Worker decides the refusals, so this command
 * does not re-check drift or destructive statements itself. It gates only on the run's target, as `migrate up` does.
 */
const runMigrateSqlCommand = async (options: MigrateSqlCommandOptions): Promise<MigrateSqlCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const dryRun = options.dryRun === true;
    const baseline = options.baseline === true;
    const { baselineThrough } = options;
    const recordOnly = baseline || baselineThrough !== undefined;

    if (options.prod && options.url === undefined) {
        return refuse(options.logger, "--prod requires an explicit --url (refusing to migrate the implicit localhost worker)", EXIT_CODE.USAGE);
    }

    const files = readSqlMigrationFiles(cwd);
    // The argument checks come first, so a bad `--baseline-through` is refused even when there is nothing to apply.
    const refusal = argumentRefusal(options, files);

    if (refusal !== undefined) {
        return refusal;
    }

    if (files.length === 0) {
        options.logger.info("no SQL migration files under lunora/migrations/ — nothing to apply");

        return { code: 0, files: [] };
    }

    const target = resolveSqlTarget(options, cwd, dryRun);

    if ("code" in target) {
        return target;
    }

    const requestUrl = `${target.baseUrl}${SQL_MIGRATIONS_PATH}`;
    const fetchImpl: FetchLike = options.fetchImpl ?? adminFetch;

    options.logger.info(`POST ${requestUrl} -> ${runVerb(dryRun, recordOnly)} ${String(files.length)} SQL file(s)`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify({ baseline, baselineThrough, confirmDestructive: options.yes === true, dryRun, files }),
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        method: "POST",
    });
    const body = await readReply(response);
    const refused = replyRefusal(response, body, target, options.logger);

    if (refused !== undefined) {
        return refused;
    }

    const plans = plansFromReply(body, files);

    if (plans === undefined) {
        return refuse(
            options.logger,
            `${target.baseUrl} answered ${dryRun ? "the plan" : "the apply"} without a valid result for every SQL file — it may not support \`migrate apply\`, or a proxy answered for it`,
            EXIT_CODE.FAILURE,
        );
    }

    for (const file of plans) {
        logSqlFilePlan(options.logger, file, dryRun);
    }

    const unfinished = unfinishedRun(plans, files, {
        baselineThrough,
        baseUrl: target.baseUrl,
        dryRun,
        logger: options.logger,
        refused: refusedFromReply(body),
    });

    if (unfinished !== undefined) {
        return { ...unfinished, files: plans };
    }

    return { code: 0, files: plans };
};

export type { MigrateSqlFilePlan };
export { runMigrateSqlCommand };
