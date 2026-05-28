import { runCodegen } from "@cirrus/codegen";
import { Spinner } from "@visulima/pail/spinner";

import type { Logger } from "../util/logger.js";
import type { SpawnDescriptor, Spawner } from "../util/spawn.js";
import { defaultSpawner } from "../util/spawn.js";
import { validateWrangler } from "../util/wrangler-validator.js";

export interface DeployCommandOptions {
    cwd?: string;
    env?: string;
    /** Set to `false` to disable interactive spinners (test injection). */
    interactive?: boolean;
    logger: Logger;
    skipCodegen?: boolean;
    spawner?: Spawner;
}

export interface DeployCommandResult {
    code: number;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before reaching the wrangler invocation. */
    error?: string;
    validation: {
        problems: ReadonlyArray<string>;
        wranglerPath: string | undefined;
    };
}

const isInteractive = (options: DeployCommandOptions): boolean => {
    if (options.interactive !== undefined) {
        return options.interactive;
    }

    return Boolean(process.stdout.isTTY) && !process.env.CI;
};

export const runDeployCommand = async (options: DeployCommandOptions): Promise<DeployCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const interactive = isInteractive(options);

    let codegenSpinner: Spinner | undefined;

    if (!options.skipCodegen) {
        if (interactive) {
            codegenSpinner = new Spinner({ name: "dots" });
            codegenSpinner.start("running codegen");
        } else {
            options.logger.info("running codegen");
        }

        try {
            runCodegen({ projectRoot: cwd });
            codegenSpinner?.succeed("codegen complete");

            if (!codegenSpinner) {
                options.logger.success("codegen complete");
            }
        } catch (error: unknown) {
            codegenSpinner?.failed("codegen failed");

            const message = error instanceof Error ? error.message : String(error);

            options.logger.error(`codegen failed: ${message}`);

            return {
                code: 1,
                descriptor: undefined,
                error: `codegen failed: ${message}`,
                validation: { problems: [], wranglerPath: undefined },
            };
        }
    }

    const validation = validateWrangler({ projectRoot: cwd });

    if (validation.problems.length > 0) {
        options.logger.error("wrangler.jsonc validation failed:");

        for (const problem of validation.problems) {
            options.logger.error(`  - ${problem}`);
        }

        return {
            code: 1,
            descriptor: undefined,
            error: "wrangler validation failed",
            validation,
        };
    }

    const args = ["exec", "wrangler", "deploy"];

    if (options.env !== undefined) {
        args.push("--env", options.env);
    }

    const descriptor: SpawnDescriptor = {
        args,
        command: "pnpm",
        cwd,
    };

    options.logger.info(`deploying via ${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    return {
        code: result.code,
        descriptor,
        validation,
    };
};
