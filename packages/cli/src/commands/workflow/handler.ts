import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { FetchLike, RunCommandResult } from "../run/handler";
import { runRpcCommand } from "../run/handler";
import type { WorkflowOptions } from "./index";

const CREATE_WORKFLOW_INSTANCE = "__lunora_admin__:createWorkflowInstance";
const SEND_WORKFLOW_EVENT = "__lunora_admin__:sendWorkflowEvent";

const USAGE =
    "Usage: lunora workflow create <exportName> [--id <id>] [--params <json>] | lunora workflow send-event <exportName> <instanceId> <eventType> [--payload <json>]";

interface WorkflowCommandOptions {
    cwd?: string;
    exportName?: string;
    fetchImpl?: FetchLike;
    format?: OutputFormat;
    /** `create`: the instance id; `send-event`: the target instance id. */
    id?: string;
    logger: Logger;
    params?: string;
    payload?: string;
    subcommand: string | undefined;
    token?: string;
    type?: string;
    url?: string;
}

/** Parse an optional JSON flag value: `{ value: undefined }` when absent, `undefined` when it is not valid JSON. */
const parseJsonFlag = (raw: string | undefined): { value: unknown } | undefined => {
    if (raw === undefined) {
        return { value: undefined };
    }

    try {
        return { value: JSON.parse(raw) };
    } catch {
        return undefined;
    }
};

const usageFailure = (logger: Logger, error: string): RunCommandResult => {
    logger.error(error);

    return { body: undefined, code: EXIT_CODE.USAGE, error, requestUrl: "" };
};

/**
 * `lunora workflow create | send-event` core: decode the arguments, then dispatch the admin op
 * the Studio Workflows panel uses through the same `/_lunora/rpc` path as `lunora run`, which
 * resolves the target, attaches the admin bearer and maps the HTTP status to an exit code. The
 * worker validates the op (declared workflow, event definition, reserved types).
 */
const runWorkflowCommand = async (options: WorkflowCommandOptions): Promise<RunCommandResult> => {
    const { logger } = options;
    const shared = { cwd: options.cwd, fetchImpl: options.fetchImpl, format: options.format, logger, token: options.token, url: options.url };

    if (options.subcommand === "create") {
        const params = parseJsonFlag(options.params);

        if (!options.exportName) {
            return usageFailure(logger, USAGE);
        }

        if (params === undefined) {
            return usageFailure(logger, "could not parse --params as JSON");
        }

        return runRpcCommand({
            ...shared,
            args: JSON.stringify({ exportName: options.exportName, ...(options.id === undefined ? {} : { id: options.id }), params: params.value }),
            functionPath: CREATE_WORKFLOW_INSTANCE,
        });
    }

    if (options.subcommand === "send-event") {
        const payload = parseJsonFlag(options.payload);

        if (!options.exportName || !options.id || !options.type) {
            return usageFailure(logger, USAGE);
        }

        if (payload === undefined) {
            return usageFailure(logger, "could not parse --payload as JSON");
        }

        return runRpcCommand({
            ...shared,
            args: JSON.stringify({ exportName: options.exportName, id: options.id, payload: payload.value, type: options.type }),
            functionPath: SEND_WORKFLOW_EVENT,
        });
    }

    return usageFailure(logger, `workflow: unknown subcommand "${options.subcommand ?? ""}". ${USAGE}`);
};

/** `lunora workflow` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<WorkflowOptions> = defineHandler<WorkflowOptions, unknown>(async ({ argument, cwd, format, logger, options }) => {
    const subcommand = argument[0];
    const result = await runWorkflowCommand({
        cwd,
        exportName: argument[1],
        format,
        // `send-event` takes the instance id positionally; `create` takes it as `--id`.
        id: subcommand === "send-event" ? argument[2] : options.id,
        logger,
        params: options.params,
        payload: options.payload,
        subcommand,
        token: options.token,
        type: argument[3],
        url: options.url,
    });

    return { code: result.code, data: result.body, error: result.error };
});

export { execute, runWorkflowCommand };
export type { WorkflowCommandOptions };
