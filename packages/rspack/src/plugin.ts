import { resolve } from "node:path";

import {
    AGENT_RULES_HINT,
    claimAgentRulesHint,
    CODEGEN_ENV,
    createConfirm,
    detectAgentRules,
    ensureDevVariables,
    fillDevSecrets,
    isCodegenDisabled,
    lunoraLine,
    runPostCodegenHook,
} from "@lunora/config";
import { reconcileBindingsSafely, validateWranglerProject } from "@lunora/config/cloudflare";
import { LunoraError } from "@lunora/errors";
import type { Project } from "ts-morph";

import type { CodegenLogger } from "./codegen";
import { createReusableProject, runCodegenPass } from "./codegen";
import type { CompilationLike, CompilerLike } from "./compiler";
import type { ResolvedLunoraRspackOptions } from "./types";

/** Tap name Rspack attributes this plugin's hooks to, in stats and in profiling output. */
const PLUGIN_NAME = "LunoraRspackPlugin";

/** Everything the plugin prints goes through the badge, so its lines read like `lunora dev`'s. */
const consoleLogger: CodegenLogger = {
    error: (message: string): void => {
        // eslint-disable-next-line no-console -- compiler-lifecycle notice; Rspack owns no logger before a compilation exists
        console.error(message);
    },
    info: (message: string): void => {
        // eslint-disable-next-line no-console -- compiler-lifecycle notice; Rspack owns no logger before a compilation exists
        console.info(message);
    },
    warn: (message: string): void => {
        // eslint-disable-next-line no-console -- compiler-lifecycle notice; Rspack owns no logger before a compilation exists
        console.warn(message);
    },
};

/**
 * Validate `wrangler.jsonc` against the bindings the schema implies, and throw
 * when it is short one. Delegates every rule to `@lunora/config` so this stays in
 * lockstep with `lunora deploy` and with `@lunora/vite`'s check.
 *
 * Unlike the Vite plugin's, this does NOT probe for Docker: that check exists
 * because `@cloudflare/vite-plugin` builds and runs container images during dev,
 * and nothing in an Rspack build does. `wrangler dev` reports its own engine
 * error when it starts the containers.
 */
const validateWrangler = (options: ResolvedLunoraRspackOptions): void => {
    const result = validateWranglerProject({ projectRoot: options.projectRoot, schemaDir: options.schemaDir });

    if (!result.wranglerPath) {
        throw new LunoraError(
            "INTERNAL",
            [
                "[lunora] wrangler.jsonc not found.",
                `  searched in: ${options.projectRoot}`,
                "  create a wrangler.jsonc declaring at least the SHARD durable object binding.",
            ].join("\n"),
        );
    }

    for (const warning of result.report.warnings) {
        consoleLogger.warn(lunoraLine(`wrangler validator: ${warning}`));
    }

    if (result.problems.length > 0) {
        throw new Error(
            [
                "[lunora] wrangler configuration is missing bindings required by your schema.",
                `  file: ${result.wranglerPath}`,
                "",
                ...result.problems.map((problem) => `  - ${problem}`),
                "",
                "  Update your wrangler.jsonc and rebuild.",
            ].join("\n"),
        );
    }
};

/**
 * Prepare `.dev.vars` and nudge for the agent rules — the two watch-mode-only
 * courtesies `lunora dev` and `@lunora/vite` both perform at startup.
 *
 * `.dev.vars` is gitignored, so a fresh clone has none and the worker
 * `wrangler dev` boots alongside this build throws on its first required secret.
 * Both steps are the shared `@lunora/config` implementations; non-interactive
 * runs decline silently.
 */
const prepareDevSession = async (options: ResolvedLunoraRspackOptions): Promise<void> => {
    const info = (message: string): void => {
        consoleLogger.info(lunoraLine(message));
    };

    await ensureDevVariables({ confirm: createConfirm("[lunora] "), cwd: options.projectRoot, info });

    fillDevSecrets({ cwd: options.projectRoot, info });

    if (!detectAgentRules(options.projectRoot).installed && claimAgentRulesHint()) {
        consoleLogger.warn(`\n${lunoraLine(AGENT_RULES_HINT)}\n`);
    }
};

/**
 * The Rspack (and webpack 5) plugin: runs `@lunora/codegen` before every
 * compilation, provisions the bindings the code implies into `wrangler.jsonc`,
 * and validates that config once at startup.
 *
 * Everything hangs off two hooks:
 *
 * `beforeCompile` carries the whole startup + regeneration pass, so a compilation
 * never reads a stale `_generated/*`. A one-shot build (`compiler.watchMode`
 * false) throws on an ERROR-level advisory or platform diagnostic, exactly as
 * `vite build` and `lunora deploy` do; a watch rebuild logs and carries on so a
 * half-typed schema does not take the watcher down with it.
 *
 * `afterCompile` registers the schema directory as a `contextDependency` so watch
 * mode rebuilds on any edit to, or addition under, `lunora/`.
 *
 * That directory contains codegen's own `_generated/` output, so the write from
 * pass N invalidates pass N+1. The loop terminates because codegen writes
 * `writeIfChanged`: pass N+1 regenerates the identical bytes, touches nothing,
 * and invalidates nothing further. Watching the directory rather than a file list
 * is what makes a NEWLY created `lunora/foo.ts` — a new query, discovered without
 * being imported from anywhere — trigger a rebuild at all.
 */
class LunoraRspackPlugin {
    /** Resolved options, fixed at construction. */
    readonly #options: ResolvedLunoraRspackOptions;

    /** Absolute schema directory — the codegen input, and the watched context. */
    readonly #schemaDirectory: string;

    /**
     * Read once, at construction: `LUNORA_CODEGEN` cannot change under a running
     * compiler, and skipping codegen has to mean skipping the watch registration
     * too or every rebuild would re-enter a pass that does nothing.
     */
    readonly #codegenDisabled: boolean;

    /** Reused ts-morph program, refreshed per pass instead of re-parsed. */
    readonly #project: { refresh: () => Project };

    /** Guards the once-per-process startup work from re-running on every rebuild. */
    #started = false;

    public constructor(options: ResolvedLunoraRspackOptions) {
        this.#options = options;
        this.#schemaDirectory = resolve(options.projectRoot, options.schemaDir);
        this.#codegenDisabled = isCodegenDisabled(process.env[CODEGEN_ENV]);
        this.#project = createReusableProject(this.#schemaDirectory);
    }

    /** Rspack's plugin entry point. */
    public apply(compiler: CompilerLike): void {
        if (this.#codegenDisabled) {
            consoleLogger.info(lunoraLine(`codegen disabled via ${CODEGEN_ENV} — skipping generation and the wrangler checks.`));

            return;
        }

        const watching = compiler.watchMode === true;

        compiler.hooks.beforeCompile.tapPromise(PLUGIN_NAME, async () => {
            await this.#pass(watching);
        });

        // `tapPromise` is the only registration the projected hook exposes, and
        // the body is synchronous — hence the bare resolved promise.
        compiler.hooks.afterCompile.tapPromise(PLUGIN_NAME, (compilation: CompilationLike) => {
            compilation.contextDependencies.add(this.#schemaDirectory);

            return Promise.resolve();
        });
    }

    /** One startup-or-rebuild pass. `watching` decides whether a blocking finding throws. */
    async #pass(watching: boolean): Promise<void> {
        if (!this.#started) {
            this.#started = true;

            if (watching) {
                await prepareDevSession(this.#options);
            }
        }

        // Before validation, and on every pass: provisioning is not validation.
        // The bindings the check below requires are the ones Lunora writes here,
        // so validating first fails the first build of any project that declares a
        // `.global()` table or a container. Idempotent.
        await reconcileBindingsSafely(this.#options, consoleLogger);

        if (this.#options.validateWrangler) {
            validateWrangler(this.#options);
        }

        const pass = runCodegenPass(this.#options, consoleLogger, this.#project.refresh());
        const hook = await runPostCodegenHook({ cwd: this.#options.projectRoot, logger: consoleLogger });

        if (watching) {
            // A watch session stays up: the developer sees the logged advisories and
            // fixes them on the next save. Killing the watcher over a half-typed
            // schema is the worst possible dev loop for a codegen-first framework.
            return;
        }

        if (hook.error !== undefined) {
            throw new Error(hook.error);
        }

        if (pass.blockingMessage !== undefined) {
            throw new Error(pass.blockingMessage);
        }
    }
}

export { consoleLogger, LunoraRspackPlugin, PLUGIN_NAME, prepareDevSession, validateWrangler };
