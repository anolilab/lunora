/**
 * `lunora cloudflare` handler — dispatches on the first positional to a
 * Cloudflare-only tool, after checking that the project deploys to Cloudflare.
 * `alert` is accepted for `alerts` and `ai` (or `ai gateway`) for
 * `ai-gateway`, the way `lunora add` accepts friendly synonyms for its items.
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
import { runContainersCommand } from "./containers/handler";
import { isDeploymentsSubcommand, runDeploymentsCommand } from "./deployments/handler";
import type { CloudflareOptions, CloudflareToolName } from "./index";
import { CLOUDFLARE_TOOLS } from "./index";
import { runProfileCommand } from "./profile/handler";

/**
 * Accepted spellings of a tool that are not its name. `absorbs` is a following
 * positional the spelling carries along — `ai gateway`, the old top-level form
 * of `ai-gateway`.
 */
const TOOL_SYNONYMS: Readonly<Record<string, { absorbs?: string; tool: CloudflareToolName }>> = {
    ai: { absorbs: "gateway", tool: "ai-gateway" },
    alert: { tool: "alerts" },
};

/** The tool `given` names, and the positionals left for it once a synonym has absorbed its word. */
const toolNamed = (given: string, rest: string[]): { rest: string[]; tool: CloudflareToolName } | undefined => {
    const synonym = TOOL_SYNONYMS[given];

    if (synonym !== undefined) {
        return { rest: synonym.absorbs !== undefined && rest[0] === synonym.absorbs ? rest.slice(1) : rest, tool: synonym.tool };
    }

    const tool = CLOUDFLARE_TOOLS.find((entry) => entry.name === given)?.name;

    return tool === undefined ? undefined : { rest, tool };
};

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

        if (tool.usage !== "") {
            logger.info(`  ${" ".repeat(width)}  lunora cloudflare ${tool.name} ${tool.usage}`);
        }
    }

    logger.info("Run `lunora cloudflare --help` for every tool's arguments and options.");

    return { code: 0 };
};

/**
 * Why `lunora cloudflare <tool>` must not run here, or `undefined` when the
 * project deploys to Cloudflare. The target resolves the canonical way —
 * `--target`, then `lunora.config.*`, then `"cloudflare"` — so this agrees with
 * what `lunora deploy` would ship to. The refusal names where the target came
 * from: a `--target` flag is not something "the project" says.
 */
const offCloudflare = (cwd: string, tool: string, explicit: string | undefined): string | undefined => {
    const { error, target } = resolveTargetOrError(cwd, explicit);

    if (target === undefined) {
        return error ?? "no deploy target";
    }

    if (target === "cloudflare") {
        return undefined;
    }

    const source = explicit === undefined ? `this project deploys to ${TARGET_NAMES[target] ?? `"${target}"`}` : `\`--target ${target}\``;

    return `${source} — \`lunora cloudflare ${tool}\` only applies to Cloudflare.`;
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

const runProfile = async ({ cwd, logger, options, rest }: ToolRun): Promise<CommandResult<unknown>> => {
    if (rest.length > 1) {
        return refuse(logger, EXIT_CODE.USAGE, `cloudflare profile: takes at most one argument (the worker), got "${rest.join(" ")}"`);
    }

    return runProfileCommand({
        actorId: options.actorId,
        cwd,
        durationMs: options.durationMs,
        env: options.env,
        logger,
        namespaceId: options.namespaceId,
        out: options.out,
        type: options.type,
        version: options.versionId,
        worker: rest[0],
    });
};

const RUNNERS: Readonly<Record<CloudflareToolName, (run: ToolRun) => Promise<CommandResult<unknown>>>> = {
    "ai-gateway": runAiGateway,
    alerts: runAlerts,
    containers: runContainers,
    deployments: runDeployments,
    profile: runProfile,
};

/** `lunora cloudflare` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CloudflareOptions> = defineHandler<CloudflareOptions, unknown>(async ({ argument, cwd, format, logger, options }) => {
    const [given, ...rest] = argument;

    if (given === undefined || given === "") {
        return printTools(logger);
    }

    const named = toolNamed(given, rest);

    if (named === undefined) {
        return refuse(logger, EXIT_CODE.USAGE, `cloudflare: unknown tool "${given}" — expected ${CLOUDFLARE_TOOLS.map((entry) => entry.name).join(" | ")}`);
    }

    // Before anything a tool does — a spawn, an API call, a file write — so a
    // celld or Node project never reaches Cloudflare through this group.
    const { tool } = named;
    const refusal = offCloudflare(cwd, tool, options.target);

    if (refusal !== undefined) {
        return refuse(logger, EXIT_CODE.USAGE, refusal);
    }

    return RUNNERS[tool]({ cwd, format, logger, options, rest: named.rest });
});

export { execute };
