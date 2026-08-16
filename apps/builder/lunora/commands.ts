import { rateLimit } from "lunorash/ratelimit";

import { api } from "#lunora/_generated/api.js";
import { action, v } from "#lunora/_generated/server.js";

import { actionLimiter, limitKey } from "./limits";
import { assertAllowedCommand, capOutput, resolveSandbox } from "./sandbox";

/**
 * Run one command against a project's working tree — the agent's `exec` tool,
 * and the terminal pane's only write path.
 *
 * An **action**, not a mutation, for the reason actions exist: it reaches a
 * container over the network, which a mutation's transaction cannot hold open.
 * The tree is loaded first and handed to the driver, so the simulated driver can
 * answer honestly about a project's actual contents rather than guessing.
 */
export const run = action
    .input({
        args: v.optional(v.array(v.string().meta({ schema: { maxLength: 512 } }))),
        command: v.string().meta({ schema: { maxLength: 64 } }),
        projectId: v.string().meta({ schema: { maxLength: 64 } }),
    })
    .use(rateLimit(actionLimiter, "exec", { key: limitKey }))
    .action(async ({ args, ctx }) => {
        // Refuse before touching anything: an argument list is attacker-chosen
        // when the caller is a model, and a rejected command should cost nothing.
        assertAllowedCommand(args.command);

        const tree = await ctx.runQuery(api.files.tree, { projectId: args.projectId });

        const files = new Map<string, string>();

        for (const file of tree.files) {
            // The tree carries sizes, not contents; the driver only needs the
            // paths to answer "does this project have a schema", and pulling
            // every body here would move a whole project per command.
            files.set(file.path, "");
        }

        // `ctx.containers` is present only when the project declares a container
        // (`lunora/containers.ts`); this one does not yet, so the cast reflects
        // the real optionality rather than asserting a binding that is absent.
        // `resolveSandbox` handles `undefined` by returning the simulated driver.
        const sandbox = resolveSandbox((ctx as { containers?: never }).containers, args.projectId);
        const result = await sandbox.exec(args.command, args.args ?? [], files);

        ctx.log.info("sandbox.exec", { code: result.code, command: args.command, driver: sandbox.kind, projectId: args.projectId });

        return {
            code: result.code,
            driver: sandbox.kind,
            stderr: capOutput(result.stderr),
            stdout: capOutput(result.stdout),
        };
    });
