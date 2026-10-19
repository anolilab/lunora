/**
 * `lunora prepare` — CI-friendly pre-deploy preparation without booting Vite.
 *
 * A thin caller of the pre-deploy pipeline `lunora deploy` runs, stopped before
 * the container build and the wrangler invocation. It is deliberately not a
 * second implementation: it was one, and the copies had drifted so that prepare
 * checked LESS than the deploy it precedes.
 */
import type { DevProcessSpawner } from "@lunora/config";
import { resolveDeployDriver, resolveLazyFunctions } from "@lunora/config";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import { runPreDeployPipeline, smokeLoadLazyModules } from "../deploy/handler";
import type { PrepareOptions } from "./index";

interface PrepareCommandOptions {
    /** Override the schema-drift gate — proceed even with breaking drift and no new migration. */
    allowSchemaDrift?: boolean;
    /** Which API spec(s) to emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    /** Opt into per-module lazy function imports. */
    lazyFunctions?: boolean;
    logger: Logger;

    /** Starts the smoke check's `wrangler dev`. Unset, the check launches a real server; a caller that must not launch one passes its own. */
    smokeLauncher?: DevProcessSpawner;

    /** `false` (`--no-smoke-load`) skips the lazy smoke check. Default on. */
    smokeLoad?: boolean;

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
     * Deploy target, matching `deploy` and `logs`. Resolved by the caller; falls back to `"target"` in `lunora.config.*`, then `"cloudflare"`.
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
 * no container image build or push, and no bundle or deploy. Its lazy smoke check
 * does start a local `wrangler dev`, the same one `deploy` runs, so it answers
 * "would this deploy?" without producing a bundle.
 */
const runPrepareCommand = async (options: PrepareCommandOptions): Promise<PrepareCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const pipeline = await runPreDeployPipeline(
        {
            allowSchemaDrift: options.allowSchemaDrift,
            apiSpec: options.apiSpec,
            lazyFunctions: resolveLazyFunctions(options.lazyFunctions),
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
            // The shared pipeline classifies its own refusals — Docker missing is
            // MISSING_DEPENDENCY, not a usage error — so keep its code and fall
            // back only when it resolved none.
            code: pipeline.code ?? EXIT_CODE.USAGE,
            error: pipeline.error,
            ...(pipeline.schemaDrift === undefined ? {} : { schemaDrift: pipeline.schemaDrift }),
            validation: pipeline.validation,
        };
    }

    // The lazy smoke check runs here too, so a module that throws at load fails the CI gate rather than the
    // deploy that follows it. Deploy runs the same check in its own preflight.
    const smokeError = await smokeLoadLazyModules(
        cwd,
        { env: undefined, logger: options.logger, smokeLauncher: options.smokeLauncher, smokeLoad: options.smokeLoad },
        resolveDeployDriver(pipeline.target),
        pipeline.validation.wranglerPath,
    );

    if (smokeError !== undefined) {
        return { code: EXIT_CODE.FAILURE, error: smokeError, validation: pipeline.validation };
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
        lazyFunctions: resolveLazyFunctions(options.lazyFunctions),
        cwd,
        logger,
        smokeLoad: options.smokeLoad,
        strictAdvisories: options.strictAdvisories,
        target: options.target,
        updateSchemaBaseline: options.updateSchemaBaseline === true,
    }),
);

export { execute };
export type { PrepareCommandOptions, PrepareCommandResult };
export { runPrepareCommand };
