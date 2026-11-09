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

/** What the Worker reports for one SQL file: what it did, or would do, and why a statement was left out. */
interface MigrateSqlFilePlan {
    destructive: string[];
    name: string;
    skipped: string[];
    state: "applied" | "baselined" | "changed" | "pending" | "ran";
    statements: string[];
}

interface MigrateSqlCommandOptions {
    /** Record the pending files as applied without running them (`migrate apply --baseline`). */
    baseline?: boolean;
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

/** The verb the log line and the error messages use for this run. */
const runVerb = (dryRun: boolean, baseline: boolean): string => {
    if (dryRun) {
        return "plan";
    }

    return baseline ? "baseline" : "apply";
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

/**
 * The per-file plans from a 200 reply, or `undefined` when the reply does not name every file that was sent. A 200 is
 * not proof the worker ran anything: a proxy or an SPA fallback can answer any path with a success. The reply has to
 * name every file, or the run did not happen and `deploy --migrate` must not go on.
 */
const plansFromReply = (body: unknown, files: ReadonlyArray<{ name: string }>): MigrateSqlFilePlan[] | undefined => {
    const reported = (body as { files?: unknown } | null | undefined)?.files;
    const reportedNames = Array.isArray(reported) ? reported.map((file: unknown) => (file as { name?: unknown } | null)?.name) : [];

    if (!Array.isArray(reported) || !files.every((file) => reportedNames.includes(file.name))) {
        return undefined;
    }

    return reported as MigrateSqlFilePlan[];
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

    if (options.prod && options.url === undefined) {
        const error = "--prod requires an explicit --url (refusing to migrate the implicit localhost worker)";

        options.logger.error(error);

        return { code: EXIT_CODE.USAGE, error, files: [] };
    }

    const files = readSqlMigrationFiles(cwd);

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

    options.logger.info(`POST ${requestUrl} -> ${runVerb(dryRun, baseline)} ${String(files.length)} SQL file(s)`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify({ baseline, confirmDestructive: options.yes === true, dryRun, files }),
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        method: "POST",
    });

    if (response.status === 404) {
        const error = `the worker at ${target.baseUrl} has no ${SQL_MIGRATIONS_PATH} route, so it predates \`migrate apply\`. Deploy a version of lunora that includes it, then re-run.`;

        options.logger.error(error);

        return { code: EXIT_CODE.NOT_FOUND, error, files: [] };
    }

    const body = await readReply(response);

    if (!response.ok) {
        // The reply is only printed when it failed: on success the per-file lines below say what happened.
        options.logger.info(JSON.stringify(body, undefined, 2));

        const error = `migrate apply was refused by ${target.baseUrl} (HTTP ${String(response.status)}) — see the response above`;

        options.logger.error(error);

        return { code: exitCodeForStatus(response.status), error, files: [] };
    }

    const plans = plansFromReply(body, files);

    if (plans === undefined) {
        const error = `${target.baseUrl} answered ${dryRun ? "the plan" : "the apply"} without a result for every SQL file — it may not support \`migrate apply\`, or a proxy answered for it`;

        options.logger.error(error);

        return { code: EXIT_CODE.FAILURE, error, files: [] };
    }

    for (const file of plans) {
        logSqlFilePlan(options.logger, file, dryRun);
    }

    // A dry run that finds a file changed since it was applied is a failed check, so CI can gate on `status --sql`.
    const drifted = plans.filter((file) => file.state === "changed").map((file) => file.name);

    if (dryRun && drifted.length > 0) {
        const error = `${String(drifted.length)} SQL file(s) changed after they were applied: ${drifted.join(", ")}`;

        options.logger.error(error);

        return { code: EXIT_CODE.CONFLICT, error, files: plans };
    }

    return { code: 0, files: plans };
};

export type { MigrateSqlFilePlan };
export { runMigrateSqlCommand };
