/**
 * `lunora prepare` — CI-friendly pre-deploy preparation without booting Vite.
 *
 * A thin caller of the pre-deploy pipeline `lunora deploy` runs, stopped before
 * the container build and the wrangler invocation. It is deliberately not a
 * second implementation: it was one, and the copies had drifted so that prepare
 * checked LESS than the deploy it precedes.
 */
import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import { runPreDeployPipeline } from "../deploy/handler";
import type { PrepareOptions } from "./index";

interface PrepareCommandOptions {
    /** Override the schema-drift gate — proceed even with breaking drift and no new migration. */
    allowSchemaDrift?: boolean;
    /** Which API spec(s) to emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    logger: Logger;

    /** Injected process runner for the `postcodegen` hook (tests). Defaults to the real spawner. */
    spawner?: Spawner;

    /**
     * Fail on ERROR-level codegen advisories. `undefined` falls back to CI
     * detection, the same as `lunora deploy` — the two run one pipeline, so the
     * opt-out has to exist on both or a CI job that `prepare` blocks has no way
     * past it short of dropping the pre-check the deploy repeats anyway.
     */
    strictAdvisories?: boolean;

    /**
     * Deploy target, matching `deploy` and `logs`. Resolved by the caller; falls back to `"target"` in `lunora.json`, then `"cloudflare"`.
     * Resolved through the same registry they use so a second driver does not
     * have to be found here separately.
     */
    target?: string;
    /** Re-bless the committed schema baseline with the current shape. */
    updateSchemaBaseline?: boolean;
}

interface PrepareCommandResult {
    code: number;
    /** Set when the run aborted in an early phase (codegen / validation / drift gate). */
    error?: string;
    /** The schema-drift gate verdict. */
    schemaDrift?: { blocked: boolean; reason: string };
    validation: {
        problems: ReadonlyArray<string>;
        wranglerPath: string | undefined;
    };
}

/**
 * `lunora prepare` — get the project ready for deployment without booting Vite.
 *
 * The whole command is now the shared pre-deploy pipeline, stopped before
 * anything ships. It used to be a second implementation of the same five steps,
 * and the two had drifted: only `deploy` gated on ERROR-level advisories, so a CI
 * job could run `lunora prepare`, go green, and still be rejected by the deploy
 * it exists to pre-check. They also provisioned by different routes.
 *
 * What `prepare` still does NOT do, which is the line between the two commands:
 * no container image build or push, and no wrangler invocation. It answers
 * "would this deploy?" without producing a bundle.
 */
const runPrepareCommand = async (options: PrepareCommandOptions): Promise<PrepareCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const pipeline = await runPreDeployPipeline(
        {
            allowSchemaDrift: options.allowSchemaDrift,
            apiSpec: options.apiSpec,
            cwd,
            logger: options.logger,
            spawner: options.spawner,
            strictAdvisories: options.strictAdvisories,
            target: options.target,
            updateSchemaBaseline: options.updateSchemaBaseline,
        },
        "prepare",
    );

    if (pipeline.error !== undefined) {
        return {
            code: 1,
            error: pipeline.error,
            ...(pipeline.schemaDrift === undefined ? {} : { schemaDrift: pipeline.schemaDrift }),
            validation: pipeline.validation,
        };
    }

    // Prepare fully succeeded — safe to advance the committed schema baseline.
    // Deferred to here for the same reason deploy defers it past wrangler: a run
    // that failed earlier must not move the goalposts the next one measures
    // against.
    pipeline.reblessSchemaBaseline?.();

    options.logger.success("project is ready to deploy");

    return { code: 0, validation: pipeline.validation };
};

/** `lunora prepare` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<PrepareOptions> = defineHandler<PrepareOptions>(({ cwd, logger, options }) =>
    runPrepareCommand({
        allowSchemaDrift: options.allowSchemaDrift === true,
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        logger,
        strictAdvisories: options.strictAdvisories,
        target: options.target,
        updateSchemaBaseline: options.updateSchemaBaseline === true,
    }),
);

export { execute };
export type { PrepareCommandOptions, PrepareCommandResult };
export { runPrepareCommand };
