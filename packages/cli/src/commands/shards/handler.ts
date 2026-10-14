import { resolveAdminBearer } from "../../util/admin-token";
import { adminFetch, resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE, exitCodeForStatus } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { FetchLike } from "../run/handler";
import type { ShardsOptions } from "./index";

/** The admin route the prune posts to. */
const SHARD_REGISTRY_PRUNE_PATH = "/_lunora/admin/shard-registry/prune";

/** The only subcommand today. */
const SHARDS_SUBCOMMANDS = ["prune"] as const;

/** One `(shard, table)` registration, as the prune route reports it. */
interface ShardRegistration {
    shardKey: string;
    table: string;
}

/** The prune route's answer. */
interface ShardRegistryPruneResult {
    failed: { message: string; shardKey: string; tables: string[] }[];
    kept: ShardRegistration[];
    released: ShardRegistration[];
}

interface ShardsCommandOptions {
    cwd?: string;
    dryRun?: boolean;
    fetchImpl?: FetchLike;
    format?: OutputFormat;
    logger: Logger;
    prod?: boolean;
    subcommand: string | undefined;
    tables?: string;
    token?: string;
    url?: string;
}

interface ShardsCommandResult {
    code: number;
    error?: string;
    result?: ShardRegistryPruneResult;
}

const shardsFailure = (logger: Logger, error: string, code: number): ShardsCommandResult => {
    logger.error(error);

    return { code, error };
};

/** Print the prune outcome for a human: one line per released and unreachable shard, then the totals. */
const reportPrune = (logger: Logger, result: ShardRegistryPruneResult, dryRun: boolean): void => {
    for (const { shardKey, table } of result.released) {
        logger.info(`${dryRun ? "would release" : "released"} ${shardKey} (${table})`);
    }

    for (const { message, shardKey, tables } of result.failed) {
        logger.error(`could not check ${shardKey} (${tables.join(", ")}) — kept: ${message}`);
    }

    const summary = `${String(result.released.length)} ${dryRun ? "would be released" : "released"}, ${String(result.kept.length)} kept (still hold rows), ${String(result.failed.length)} unreachable`;

    if (result.failed.length > 0) {
        logger.warn(`${summary} — re-run to retry the unreachable shards`);
    } else {
        logger.success(summary);
    }
};

/**
 * `lunora shards prune` core: POST the prune route, which asks every shard the
 * registry lists to release the `.shardBy()` tables it holds no rows of. Exits
 * non-zero when any shard could not be reached (the route answers 207), since
 * those entries were kept unchecked.
 */
const runShardsCommand = async (options: ShardsCommandOptions): Promise<ShardsCommandResult> => {
    const { logger } = options;

    if (!SHARDS_SUBCOMMANDS.includes(options.subcommand as (typeof SHARDS_SUBCOMMANDS)[number])) {
        return shardsFailure(logger, `shards: unknown subcommand "${options.subcommand ?? ""}" — expected ${SHARDS_SUBCOMMANDS.join(" | ")}`, EXIT_CODE.USAGE);
    }

    if (options.prod && options.url === undefined) {
        return shardsFailure(logger, "--prod requires an explicit --url (refusing to prune the implicit localhost worker)", EXIT_CODE.USAGE);
    }

    const baseUrl = resolveAdminBaseUrl(options.url, logger, options.cwd);

    if (baseUrl === undefined) {
        // `resolveAdminBaseUrl` logged the reason it refused the target.
        return { code: EXIT_CODE.USAGE, error: "could not resolve a usable worker URL" };
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        return shardsFailure(
            logger,
            "admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)",
            EXIT_CODE.AUTH,
        );
    }

    const requestUrl = `${baseUrl}${SHARD_REGISTRY_PRUNE_PATH}`;
    const fetchImpl: FetchLike = options.fetchImpl ?? adminFetch;
    const tables = options.tables
        ?.split(",")
        .map((table) => table.trim())
        .filter((table) => table !== "");
    const dryRun = options.dryRun === true;

    logger.info(`POST ${requestUrl} -> shards prune${dryRun ? " (dry run)" : ""}`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify({ dryRun, ...(tables === undefined ? {} : { tables }) }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });

    const text = await response.text();

    // 207 is the route's "some shards were unreachable" answer: a result, not a failure.
    if (!response.ok) {
        return shardsFailure(logger, `shards prune failed: HTTP ${String(response.status)}: ${text}`, exitCodeForStatus(response.status));
    }

    let result: ShardRegistryPruneResult;

    try {
        result = JSON.parse(text) as ShardRegistryPruneResult;
    } catch {
        return shardsFailure(logger, `shards prune failed: worker returned non-JSON: ${text}`, 1);
    }

    if (options.format !== "json") {
        reportPrune(logger, result, dryRun);
    }

    return result.failed.length > 0
        ? { code: 1, error: `shards prune: ${String(result.failed.length)} shard(s) could not be checked`, result }
        : { code: 0, result };
};

/** `lunora shards` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<ShardsOptions> = defineHandler<ShardsOptions, ShardRegistryPruneResult>(async ({ argument, cwd, format, logger, options }) => {
    const result = await runShardsCommand({
        cwd,
        dryRun: options.dryRun === true,
        format,
        logger,
        prod: options.prod,
        subcommand: argument[0],
        tables: options.tables,
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
    });

    return { code: result.code, data: result.result, error: result.error };
});

export { execute, runShardsCommand };
export type { ShardRegistryPruneResult, ShardsCommandOptions, ShardsCommandResult };
