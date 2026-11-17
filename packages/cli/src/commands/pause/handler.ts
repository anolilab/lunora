import { resolveAdminBearer } from "../../util/admin-token";
import { adminFetch, resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE, exitCodeForStatus } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { FetchLike } from "../run/handler";
import type { PauseOptions } from "./index";

const PAUSE_PATH = "/_lunora/admin/pause";

/** The pause route's answer. */
interface PauseStatus {
    paused: boolean;
    pausedAt?: number;
    reason?: string;
    supported: boolean;
}

type PauseAction = "pause" | "resume" | "status";

interface PauseCommandOptions {
    action: PauseAction;
    cwd?: string;
    fetchImpl?: FetchLike;
    format?: OutputFormat;
    logger: Logger;
    prod?: boolean;
    reason?: string;
    token?: string;
    url?: string;
}

interface PauseCommandResult {
    code: number;
    error?: string;
    result?: PauseStatus;
}

const failure = (logger: Logger, error: string, code: number): PauseCommandResult => {
    logger.error(error);

    return { code, error };
};

const describe = (status: PauseStatus): string => {
    if (!status.paused) {
        return "running";
    }

    const since = status.pausedAt === undefined ? "" : ` since ${new Date(status.pausedAt).toISOString()}`;

    return `paused${since}${status.reason === undefined ? "" : ` — ${status.reason}`}`;
};

/**
 * `lunora pause` / `lunora resume` core: read or set the deployment pause flag
 * through the admin route the Studio toggle uses.
 */
const runPauseCommand = async (options: PauseCommandOptions): Promise<PauseCommandResult> => {
    const { logger } = options;

    if (options.prod && options.url === undefined) {
        return failure(logger, `--prod requires an explicit --url (refusing to ${options.action} the implicit localhost worker)`, EXIT_CODE.USAGE);
    }

    const baseUrl = resolveAdminBaseUrl(options.url, logger, options.cwd);

    if (baseUrl === undefined) {
        // `resolveAdminBaseUrl` logged the reason it refused the target.
        return { code: EXIT_CODE.USAGE, error: "could not resolve a usable worker URL" };
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        return failure(logger, "admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)", EXIT_CODE.AUTH);
    }

    const requestUrl = `${baseUrl}${PAUSE_PATH}`;
    const fetchImpl: FetchLike = options.fetchImpl ?? adminFetch;
    const response =
        options.action === "status"
            ? await fetchImpl(requestUrl, { headers: { authorization: `Bearer ${token}` }, method: "GET" })
            : await fetchImpl(requestUrl, {
                  body: JSON.stringify({ paused: options.action === "pause", ...(options.reason === undefined ? {} : { reason: options.reason }) }),
                  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                  method: "POST",
              });
    const text = await response.text();

    if (!response.ok) {
        return failure(logger, `${options.action} failed: HTTP ${String(response.status)}: ${text}`, exitCodeForStatus(response.status));
    }

    let result: PauseStatus;

    try {
        result = JSON.parse(text) as PauseStatus;
    } catch {
        return failure(logger, `${options.action} failed: worker returned non-JSON: ${text}`, 1);
    }

    if (options.format !== "json") {
        if (!result.supported) {
            logger.warn("this deployment has no scheduler, so it cannot be paused");
        } else if (options.action === "status") {
            logger.info(describe(result));
        } else {
            logger.success(`${baseUrl}: ${describe(result)}`);
        }
    }

    return { code: 0, result };
};

/**
 * Why the positional arguments are not a valid `pause` / `resume` invocation,
 * or `undefined`. Strict on purpose: a typo must fail rather than flip a
 * production deployment.
 */
const pauseUsageError = (command: "pause" | "resume", argument: ReadonlyArray<string>): string | undefined => {
    if (command === "resume") {
        return argument.length === 0 ? undefined : `resume takes no arguments, got "${argument.join(" ")}"`;
    }

    if (argument.length > 1 || (argument.length === 1 && argument[0] !== "status")) {
        return `unknown arguments "${argument.join(" ")}" — expected status, or none to pause`;
    }

    return undefined;
};

/** `lunora pause` handler (lazy-loaded via the command's `loader`). */
const executePause: CommandHandler<PauseOptions> = defineHandler<PauseOptions, PauseStatus>(async ({ argument, cwd, format, logger, options }) => {
    const usage = pauseUsageError("pause", argument);

    if (usage !== undefined) {
        logger.error(`pause: ${usage}`);

        return { code: EXIT_CODE.USAGE, error: usage };
    }

    const [subcommand] = argument;

    const result = await runPauseCommand({
        action: subcommand === "status" ? "status" : "pause",
        cwd,
        format,
        logger,
        prod: options.prod,
        reason: options.reason,
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
    });

    return { code: result.code, data: result.result, error: result.error };
});

/** `lunora resume` handler (lazy-loaded via the command's `loader`). */
const executeResume: CommandHandler<PauseOptions> = defineHandler<PauseOptions, PauseStatus>(async ({ argument, cwd, format, logger, options }) => {
    const usage = pauseUsageError("resume", argument);

    if (usage !== undefined) {
        logger.error(`resume: ${usage}`);

        return { code: EXIT_CODE.USAGE, error: usage };
    }

    const result = await runPauseCommand({
        action: "resume",
        cwd,
        format,
        logger,
        prod: options.prod,
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
    });

    return { code: result.code, data: result.result, error: result.error };
});

export { executePause, executeResume, pauseUsageError, runPauseCommand };
export type { PauseCommandOptions, PauseCommandResult, PauseStatus };
