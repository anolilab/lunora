import { rateLimit } from "lunorash/ratelimit";

import { internal } from "#lunora/_generated/api.js";
import type { ActionCtx } from "#lunora/_generated/server.js";
import { action, internalAction, v } from "#lunora/_generated/server.js";

import { authorizeProject } from "./authz";
import { actionLimiter, limitKey } from "./limits";
import { assertAllowedCommand, capOutput, resolveSandbox } from "./sandbox";

/** One command's result, as both the terminal pane and the agent's `exec` tool see it. */
interface CommandResult {
    code: number;
    driver: string;
    stderr: string;
    stdout: string;
}

/**
 * Run one command against a project's working tree.
 *
 * The tree is loaded first and handed to the driver, so the simulated driver can
 * answer honestly about a project's actual contents rather than guessing. It is
 * read through `internal.files.listInternal` rather than the public
 * `api.files.tree`: the public query authorizes the caller's session, and the
 * durable agent loop dispatches with no identity, so routing the agent through it
 * would deny the agent its own project.
 */
const execute = async (ctx: ActionCtx, arguments_: { args?: ReadonlyArray<string>; command: string; projectId: string }): Promise<CommandResult> => {
    // Refuse before touching anything: an argument list is attacker-chosen
    // when the caller is a model, and a rejected command should cost nothing.
    assertAllowedCommand(arguments_.command);

    const tree = await ctx.runQuery(internal.files.listInternal, { projectId: arguments_.projectId });

    const files = new Map<string, string>();

    for (const path of tree.paths) {
        // The listing carries paths, not contents; the driver only needs the
        // paths to answer "does this project have a schema", and pulling
        // every body here would move a whole project per command.
        files.set(path, "");
    }

    // `ctx.containers` is present only when the project declares a container
    // (`lunora/containers.ts`); this one does not yet, so the cast reflects
    // the real optionality rather than asserting a binding that is absent.
    // `resolveSandbox` handles `undefined` by returning the simulated driver.
    const sandbox = resolveSandbox((ctx as { containers?: never }).containers, arguments_.projectId);
    const result = await sandbox.exec(arguments_.command, arguments_.args ?? [], files);

    ctx.log.info("sandbox.exec", { code: result.code, command: arguments_.command, driver: sandbox.kind, projectId: arguments_.projectId });

    return {
        code: result.code,
        driver: sandbox.kind,
        stderr: capOutput(result.stderr),
        stdout: capOutput(result.stdout),
    };
};

/**
 * The terminal pane's only write path.
 *
 * An **action**, not a mutation, for the reason actions exist: it reaches a
 * container over the network, which a mutation's transaction cannot hold open.
 *
 * `projectId` comes from the URL, so it is authorized before a process starts:
 * running `wrangler` or `pnpm` against a project the caller does not own is the
 * same IDOR as reading its files, with a process attached.
 */
export const run = action
    .input({
        args: v.optional(v.array(v.string().meta({ schema: { maxLength: 512 } }))),
        command: v.string().meta({ schema: { maxLength: 64 } }),
        projectId: v.string().meta({ schema: { maxLength: 64 } }),
    })
    .use(rateLimit(actionLimiter, "exec", { key: limitKey }))
    .action(async ({ args, ctx }): Promise<CommandResult> => {
        const { projectId } = await authorizeProject(ctx, args.projectId);

        ctx.log.info("command.run", { command: args.command, projectId });

        return execute(ctx, { args: args.args, command: args.command, projectId });
    });

/**
 * The agent's `exec` / `verify` tools. Internal, so the model cannot reach it as
 * a public RPC, and so it is not gated on a session the durable loop does not
 * carry. Its blast radius is bounded by the same command allowlist the public
 * path uses.
 */
export const runInternal = internalAction
    .input({ args: v.optional(v.array(v.string())), command: v.string(), projectId: v.string() })
    .action(async ({ args, ctx }): Promise<CommandResult> => execute(ctx, args));
