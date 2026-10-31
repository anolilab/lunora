import { resolveAdminBearer } from "../../util/admin-token";
import { adminFetch, resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE, exitCodeForStatus } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { FetchLike } from "../run/handler";
import type { AdminTokenOptions } from "./index";

const ADMIN_TOKENS_PATH = "/_lunora/admin/tokens";

const DAY_MS = 86_400_000;

const SUBCOMMANDS = ["create", "list", "revoke"] as const;

interface AdminTokenCommandOptions {
    cwd?: string;
    expiresDays?: number;
    fetchImpl?: FetchLike;
    format?: OutputFormat;
    logger: Logger;
    name?: string;
    now?: () => number;
    prod?: boolean;
    subcommand: string | undefined;
    token?: string;
    url?: string;
}

interface AdminTokenCommandResult {
    code: number;
    data?: unknown;
    error?: string;
}

interface TokenRow {
    createdAt: number;
    expiresAt?: number;
    lastUsedAt?: number;
    name: string;
}

const failure = (logger: Logger, error: string, code: number): AdminTokenCommandResult => {
    logger.error(error);

    return { code, error };
};

const when = (epochMs: number | undefined, fallback: string): string => (epochMs === undefined ? fallback : new Date(epochMs).toISOString());

const request = (subcommand: (typeof SUBCOMMANDS)[number], options: AdminTokenCommandOptions): { body?: string; method: string; path: string } => {
    if (subcommand === "list") {
        return { method: "GET", path: ADMIN_TOKENS_PATH };
    }

    if (subcommand === "revoke") {
        return { method: "DELETE", path: `${ADMIN_TOKENS_PATH}?name=${encodeURIComponent(options.name ?? "")}` };
    }

    const expiresAt = options.expiresDays === undefined ? undefined : (options.now ?? Date.now)() + options.expiresDays * DAY_MS;

    return { body: JSON.stringify({ expiresAt, name: options.name }), method: "POST", path: ADMIN_TOKENS_PATH };
};

const report = (logger: Logger, subcommand: (typeof SUBCOMMANDS)[number], data: Record<string, unknown>, name: string | undefined): void => {
    if (subcommand === "create") {
        logger.success(`created admin token "${String(data.name)}" — copy it now, it is not shown again:`);
        logger.info(String(data.token));

        return;
    }

    if (subcommand === "revoke") {
        logger.success(`revoked admin token "${String(name)}"`);

        return;
    }

    const tokens = (data.tokens ?? []) as TokenRow[];

    if (tokens.length === 0) {
        logger.info("no named admin tokens");
    }

    for (const row of tokens) {
        logger.info(`${row.name}  created ${when(row.createdAt, "?")}  last used ${when(row.lastUsedAt, "never")}  expires ${when(row.expiresAt, "never")}`);
    }
};

/** `lunora admin-token` core: one call to `/_lunora/admin/tokens`, which only the root admin token may make. */
const runAdminTokenCommand = async (options: AdminTokenCommandOptions): Promise<AdminTokenCommandResult> => {
    const { logger } = options;
    const subcommand = SUBCOMMANDS.find((candidate) => candidate === options.subcommand);

    if (subcommand === undefined) {
        return failure(logger, `admin-token: unknown subcommand "${options.subcommand ?? ""}" — expected ${SUBCOMMANDS.join(" | ")}`, EXIT_CODE.USAGE);
    }

    if (subcommand !== "list" && (options.name === undefined || options.name === "")) {
        return failure(logger, `admin-token ${subcommand}: a token name is required`, EXIT_CODE.USAGE);
    }

    if (options.expiresDays !== undefined && (!Number.isFinite(options.expiresDays) || options.expiresDays <= 0)) {
        return failure(logger, "--expires-days must be a positive number", EXIT_CODE.USAGE);
    }

    if (options.prod && options.url === undefined) {
        return failure(logger, "--prod requires an explicit --url", EXIT_CODE.USAGE);
    }

    const baseUrl = resolveAdminBaseUrl(options.url, logger, options.cwd);

    if (baseUrl === undefined) {
        return { code: EXIT_CODE.USAGE, error: "could not resolve a usable worker URL" };
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        return failure(logger, "root admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)", EXIT_CODE.AUTH);
    }

    const { body, method, path } = request(subcommand, options);
    const response = await (options.fetchImpl ?? adminFetch)(`${baseUrl}${path}`, {
        body,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method,
    });
    const text = await response.text();

    if (!response.ok) {
        return failure(logger, `admin-token ${subcommand} failed: HTTP ${String(response.status)}: ${text}`, exitCodeForStatus(response.status));
    }

    let data: Record<string, unknown>;

    try {
        data = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return failure(logger, `admin-token ${subcommand} failed: worker returned non-JSON: ${text}`, 1);
    }

    // The secret is shown once and cannot be recovered from `list`, so success without it is a failure.
    if (subcommand === "create" && (typeof data.token !== "string" || data.token.length === 0)) {
        return failure(logger, "admin-token create failed: the worker's answer did not include the created token", 1);
    }

    if (options.format !== "json") {
        report(logger, subcommand, data, options.name);
    }

    return { code: 0, data };
};

/** `lunora admin-token` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AdminTokenOptions> = defineHandler<AdminTokenOptions, unknown>(async ({ argument, cwd, format, logger, options }) => {
    const result = await runAdminTokenCommand({
        cwd,
        expiresDays: options.expiresDays,
        format,
        logger,
        name: argument[1],
        prod: options.prod,
        subcommand: argument[0],
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
    });

    return { code: result.code, data: result.data, error: result.error };
});

export { execute, runAdminTokenCommand };
export type { AdminTokenCommandOptions, AdminTokenCommandResult };
