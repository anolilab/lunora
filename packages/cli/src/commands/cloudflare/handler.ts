/**
 * `lunora cloudflare` handler — dispatches on the first positional to a
 * Cloudflare-only tool, after checking that the project deploys to Cloudflare.
 * `alert` is accepted for `alerts`, the way `lunora add` accepts friendly
 * synonyms for its items.
 */
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveTargetOrError } from "../../util/deploy-target";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { CommandResult, OutputFormat } from "../../util/output-format";
import { runAiGatewayCommand } from "./ai-gateway/handler";
import type { AlertsSubcommand } from "./alerts/handler";
import { runAlertsCommand } from "./alerts/handler";
import { runAnalyzeCommand } from "./analyze/handler";
import { runContainersCommand } from "./containers/handler";
import { isDeploymentsSubcommand, runDeploymentsCommand } from "./deployments/handler";
import type { CloudflareOptions, CloudflareToolName } from "./index";
import { CLOUDFLARE_TOOLS } from "./index";

/** Accepted spellings of a tool that are not its name. */
const TOOL_SYNONYMS: Readonly<Record<string, CloudflareToolName>> = { alert: "alerts" };

const toolNamed = (name: string): CloudflareToolName | undefined => TOOL_SYNONYMS[name] ?? CLOUDFLARE_TOOLS.find((tool) => tool.name === name)?.name;

/** How the refusal names each non-Cloudflare host. */
const TARGET_NAMES: Readonly<Record<string, string>> = { celld: "celld", node: "Node" };

const isAlertsSubcommand = (value: string): value is AlertsSubcommand => value === "status" || value === "setup" || value === "test";

const refuse = (logger: Logger, code: number, message: string): CommandResult<never> => {
    logger.error(message);

    return { code, error: message };
};

/** The listing a bare `lunora cloudflare` prints. */
const printTools = (logger: Logger): CommandResult<never> => {
    const width = Math.max(...CLOUDFLARE_TOOLS.map((tool) => tool.name.length));

    logger.info("lunora cloudflare <tool> — tools for an app deployed to your own Cloudflare account:");

    for (const tool of CLOUDFLARE_TOOLS) {
        logger.info(`  ${tool.name.padEnd(width)}  ${tool.summary}`);
    }

    logger.info("Run `lunora cloudflare --help` for every tool's arguments and options.");

    return { code: 0 };
};

/**
 * Why `lunora cloudflare <tool>` must not run here, or `undefined` when the
 * project deploys to Cloudflare. The target resolves the canonical way —
 * `--target`, then `lunora.config.*`, then `"cloudflare"` — so this agrees with
 * what `lunora deploy` would ship to.
 */
const offCloudflare = (cwd: string, tool: string, explicit: string | undefined): string | undefined => {
    const { error, target } = resolveTargetOrError(cwd, explicit);

    if (target === undefined) {
        return error ?? "no deploy target";
    }

    if (target === "cloudflare") {
        return undefined;
    }

    return `this project deploys to ${TARGET_NAMES[target] ?? `"${target}"`} — \`lunora cloudflare ${tool}\` only applies to Cloudflare.`;
};

/** What a tool runner receives: the arguments after the tool name, plus the handler context. */
interface ToolRun {
    cwd: string;
    format: OutputFormat;
    logger: Logger;
    options: CloudflareOptions;
    rest: string[];
}

/** Refuse positionals for a tool that takes none, rather than silently ignoring them. */
const strayArguments = (tool: string, { logger, rest }: ToolRun): CommandResult<never> | undefined =>
    rest.length === 0 ? undefined : refuse(logger, EXIT_CODE.USAGE, `cloudflare ${tool}: takes no arguments, got "${rest.join(" ")}"`);

const runAiGateway = async (run: ToolRun): Promise<CommandResult<unknown>> => {
    const { cwd, logger, options } = run;

    return strayArguments("ai-gateway", run) ?? runAiGatewayCommand({ cwd, dryRun: options.dryRun === true, id: options.id, logger, logs: options.logs });
};

const runAlerts = async ({ cwd, format, logger, options, rest }: ToolRun): Promise<CommandResult<unknown>> => {
    const sub = rest[0] ?? "status";

    if (!isAlertsSubcommand(sub)) {
        return refuse(logger, EXIT_CODE.USAGE, `cloudflare alerts: unknown subcommand "${sub}" — expected status | setup | test`);
    }

    return runAlertsCommand({
        allowFloor: options.allowFloor === true,
        cwd,
        dryRun: options.dryRun === true,
        format,
        logger,
        replaceRecipients: options.replaceRecipients === true,
        subcommand: sub,
        yes: options.yes === true,
        ...(options.email === undefined ? {} : { emails: options.email }),
        ...(options.webhook === undefined ? {} : { webhooks: options.webhook }),
        ...(options.multiplier === undefined ? {} : { multiplier: options.multiplier }),
        ...(options.threshold === undefined ? {} : { thresholds: options.threshold }),
    });
};

const runAnalyze = async (run: ToolRun): Promise<CommandResult<unknown>> => {
    const stray = strayArguments("analyze", run);

    if (stray !== undefined) {
        return stray;
    }

    const result = await runAnalyzeCommand({ cwd: run.cwd, format: run.format, logger: run.logger });

    return { code: result.code, data: result.report, error: result.error };
};

const runContainers = async ({ cwd, format, logger, options, rest }: ToolRun): Promise<CommandResult<unknown>> => {
    const result = await runContainersCommand({ argument: rest, cwd, env: options.env, format, logger, push: options.push === true, tag: options.tag });

    // Both markers travel, and both matter in `--format json`. Dropping
    // `delegated` appended a second envelope after wrangler's own document, so
    // the stdout of a forwarded read was two JSON documents concatenated and
    // parsed as neither. Dropping `error` left a refusal's envelope carrying an
    // exit code with nothing saying why.
    return { code: result.code, delegated: result.delegated, error: result.error };
};

const runDeployments = async ({ cwd, format, logger, options, rest }: ToolRun): Promise<CommandResult<unknown>> => {
    const [sub, versionId] = rest;

    if (!isDeploymentsSubcommand(sub)) {
        return refuse(logger, EXIT_CODE.USAGE, `cloudflare deployments: unknown subcommand "${sub ?? ""}" — expected list | inspect | rollback | promote`);
    }

    const result = await runDeploymentsCommand({
        cwd,
        env: options.env,
        format,
        logger,
        message: options.message,
        subcommand: sub,
        versionId,
        yes: options.yes === true,
    });

    // `delegated` for the same reason as containers: `list --format json` is wrangler's document.
    return { code: result.code, delegated: result.delegated, error: result.error };
};

const RUNNERS: Readonly<Record<CloudflareToolName, (run: ToolRun) => Promise<CommandResult<unknown>>>> = {
    "ai-gateway": runAiGateway,
    alerts: runAlerts,
    analyze: runAnalyze,
    containers: runContainers,
    deployments: runDeployments,
};

/** `lunora cloudflare` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CloudflareOptions> = defineHandler<CloudflareOptions, unknown>(async ({ argument, cwd, format, logger, options }) => {
    const [given, ...rest] = argument;

    if (given === undefined || given === "") {
        return printTools(logger);
    }

    const tool = toolNamed(given);

    if (tool === undefined) {
        return refuse(logger, EXIT_CODE.USAGE, `cloudflare: unknown tool "${given}" — expected ${CLOUDFLARE_TOOLS.map((entry) => entry.name).join(" | ")}`);
    }

    // Before anything a tool does — a spawn, an API call, a file write — so a
    // celld or Node project never reaches Cloudflare through this group.
    const refusal = offCloudflare(cwd, tool, options.target);

    if (refusal !== undefined) {
        return refuse(logger, EXIT_CODE.USAGE, refusal);
    }

    return RUNNERS[tool]({ cwd, format, logger, options, rest });
});

export { execute };
