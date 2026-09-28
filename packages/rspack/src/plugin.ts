import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { findTsconfig, fingerprintSchemaSources } from "@lunora/codegen";
import {
    AGENT_RULES_HINT,
    claimAgentRulesHint,
    CODEGEN_ENV,
    createConfirm,
    detectAgentRules,
    ensureDevVariables,
    ensureDevWorkerEnv,
    fillDevSecrets,
    isCodegenDisabled,
    lunoraLine,
    runPostCodegenHook,
} from "@lunora/config";
import { assertWranglerSatisfiesSchema, reconcileBindingsSafely } from "@lunora/config/cloudflare";

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
 * Prepare `.dev.vars` and nudge for the agent rules — the watch-mode-only
 * courtesies `lunora dev` and `@lunora/vite` both perform at startup.
 *
 * `.dev.vars` is gitignored, so a fresh clone has none and the Worker that
 * `wrangler dev` boots alongside this build throws on its first required secret.
 * All three steps are the shared `@lunora/config` implementations;
 * non-interactive runs decline silently.
 */
const prepareDevSession = async (options: ResolvedLunoraRspackOptions): Promise<void> => {
    const info = (message: string): void => {
        consoleLogger.info(lunoraLine(message));
    };

    await ensureDevVariables({ confirm: createConfirm("[lunora] "), cwd: options.projectRoot, info });

    fillDevSecrets({ cwd: options.projectRoot, info });
    // `wrangler dev` loads `.dev.vars` but sets no `WORKER_ENV` of its own, and
    // this plugin never runs the Worker — so without this a developer running
    // plain `wrangler dev` alongside their build spends the session with
    // `isDevEnvironment` false. (`lunora dev` passes `--var` and is unaffected.)
    ensureDevWorkerEnv(options.projectRoot, info);

    if (!detectAgentRules(options.projectRoot).installed && claimAgentRulesHint()) {
        consoleLogger.warn(`\n${lunoraLine(AGENT_RULES_HINT)}\n`);
    }
};

/**
 * The Rspack (and webpack 5) plugin: runs `@lunora/codegen` before every
 * compilation, provisions the Cloudflare bindings the code implies into
 * `wrangler.jsonc`, and validates that config.
 *
 * Everything hangs off two hooks. `beforeCompile` carries the startup and
 * regeneration pass, so a compilation never reads a stale `_generated/*`.
 * `afterCompile` registers the watch dependencies and reports whatever the pass
 * found into `compilation.errors`.
 *
 * **Findings are reported, never thrown.** A rejected hook takes a watch session
 * down with it; `compilation.errors` fails a one-shot build just as hard (assets
 * are not emitted and the CLI exits non-zero) while leaving the watcher up to
 * regenerate on the next save. That is what lets one code path serve both modes,
 * and `compiler.watchMode` then decides only whether a *schema advisory* is worth
 * failing over — a production build refuses one, exactly as `vite build` and
 * `lunora deploy` do, and a watch rebuild logs it and carries on.
 */
class LunoraRspackPlugin {
    /** Resolved options, fixed at construction. */
    readonly #options: ResolvedLunoraRspackOptions;

    /** Absolute schema directory — the codegen input, and the watched context. */
    readonly #schemaDirectory: string;

    /** Read once: `LUNORA_CODEGEN` cannot change under a running compiler. */
    readonly #codegenDisabled: boolean;

    /** Reused ts-morph program, refreshed per pass instead of re-parsed. */
    readonly #project: ReturnType<typeof createReusableProject>;

    /** Guards the once-per-session startup work from re-running on every rebuild. */
    #started = false;

    /** Content hash of everything codegen reads, from the last pass that ran. */
    #lastFingerprint: string | undefined;

    /** The `tsconfig.json` contents the cached Project was built from. */
    #lastTsconfig: string | undefined;

    /** Findings from the last pass that ran, re-reported on every compilation until it runs again. */
    #findings: Error[] = [];

    /** The in-flight pass, so concurrent compilers share one instead of racing. */
    #inFlight: Promise<void> | undefined;

    public constructor(options: ResolvedLunoraRspackOptions) {
        this.#options = options;
        this.#schemaDirectory = resolve(options.projectRoot, options.schemaDir);
        this.#codegenDisabled = isCodegenDisabled(process.env[CODEGEN_ENV]);
        this.#project = createReusableProject(this.#schemaDirectory);
    }

    /** Rspack's plugin entry point. */
    public apply(compiler: CompilerLike): void {
        compiler.hooks.beforeCompile.tapPromise(PLUGIN_NAME, async () => {
            // `watchMode` is read HERE, not at tap time: `apply()` runs inside
            // `createCompiler()`, before `compiler.watch()` assigns it, so at tap
            // time it is always `false`.
            //
            // One instance can be applied to several compilers (an array config, or
            // an Rsbuild with more than one environment), whose `beforeCompile`
            // hooks then interleave. Sharing the in-flight promise keeps that to a
            // single pass rather than duplicated codegen and two concurrent
            // `postcodegen` subprocesses.
            this.#inFlight ??= this.#pass(compiler.watchMode === true).finally(() => {
                this.#inFlight = undefined;
            });

            await this.#inFlight;
        });

        compiler.hooks.afterCompile.tapPromise(PLUGIN_NAME, (compilation: CompilationLike) => {
            // The DIRECTORY, not a file list: a brand-new `lunora/foo.ts` is
            // discovered by codegen without being imported from anywhere, so a
            // file-list watch would never see it appear.
            compilation.contextDependencies.add(this.#schemaDirectory);

            // Not under the schema directory, so it needs its own registration — a
            // new path alias or `include` changes what codegen resolves.
            const tsconfigPath = findTsconfig(this.#schemaDirectory);

            if (tsconfigPath !== undefined) {
                compilation.fileDependencies.add(tsconfigPath);
            }

            for (const finding of this.#findings) {
                compilation.errors.push(finding);
            }

            return Promise.resolve();
        });
    }

    /**
     * One startup-or-rebuild pass. `watching` decides only whether a blocking
     * schema advisory is reported as a build error.
     */
    async #pass(watching: boolean): Promise<void> {
        // A DEV switch, honoured only in watch mode. A one-shot build must keep
        // generating, because the escalation in `#generate` is the only thing that
        // fails a build on an ERROR-level advisory or platform diagnostic —
        // skipping generation would skip that gate too, shipping an app against a
        // surface its target cannot serve, green the whole way, from a variable
        // someone exported in a shell profile.
        if (watching && this.#codegenDisabled) {
            if (!this.#started) {
                this.#started = true;
                consoleLogger.info(lunoraLine(`codegen disabled via ${CODEGEN_ENV} — skipping generation and the wrangler checks.`));
            }

            return;
        }

        const tsconfig = this.#readTsconfig();

        if (tsconfig !== this.#lastTsconfig) {
            // `refreshCodegenProject` only re-reads files the program already knows
            // about, so a changed `paths`/`include` is invisible to it. Forget the
            // fingerprint too, so this pass runs rather than being skipped below.
            this.#project.drop();
            this.#lastTsconfig = tsconfig;
            this.#lastFingerprint = undefined;
        }

        // The whole pass is gated on the content of what codegen READS — which
        // excludes `_generated/`. This is what makes watching the entire schema
        // directory safe: codegen's own output, and anything a `postcodegen` hook
        // rewrites under `_generated/`, invalidates the next compilation but leaves
        // this hash alone, so the pass no-ops and the cascade stops. Without it a
        // formatter-style `postcodegen` regenerates then reformats then regenerates
        // forever (measured: 73 compilations in 25s), which `@lunora/vite` needs
        // three separate guards to prevent.
        //
        // ponytail: a NON-idempotent postcodegen that rewrites a SOURCE file
        // differently each run still oscillates. Vite caps that with
        // MAX_SETTLE_RERUNS; add the same counter here if anyone hits it.
        const fingerprint = fingerprintSchemaSources(this.#schemaDirectory);

        if (fingerprint === this.#lastFingerprint) {
            return;
        }

        this.#lastFingerprint = fingerprint;

        if (!this.#started) {
            this.#started = true;

            if (watching) {
                await prepareDevSession(this.#options);
            }
        }

        this.#findings = [];

        try {
            await this.#generate(watching);
        } catch (error: unknown) {
            // A codegen crash, or a wrangler config that cannot satisfy the schema.
            // Reported, not rethrown, so a watch session survives a half-typed
            // schema and regenerates on the next save. The Project is dropped
            // because a run that threw may have left it partially mutated.
            this.#project.drop();
            this.#findings.push(error instanceof Error ? error : new Error(String(error)));
            consoleLogger.error(error instanceof Error ? error.message : String(error));
        }
    }

    /** The pass proper, in the order the steps depend on each other. */
    async #generate(watching: boolean): Promise<void> {
        // Before validation, and on every pass: provisioning is not validation.
        // The bindings the check below requires are largely the ones Lunora writes
        // here, so validating first fails the first build of any project that
        // declares a `.global()` table or a container. Idempotent.
        await reconcileBindingsSafely(this.#options, consoleLogger);

        if (this.#options.validateWrangler) {
            assertWranglerSatisfiesSchema(this.#options, consoleLogger.warn, "Update your wrangler.jsonc and rebuild.");
        }

        const blockingMessage = runCodegenPass(this.#options, consoleLogger, this.#project.get());
        const hook = await runPostCodegenHook({ cwd: this.#options.projectRoot, logger: consoleLogger });

        if (hook.error !== undefined) {
            this.#findings.push(new Error(hook.error));
        }

        // A watch session stays up on a schema advisory: the developer sees the
        // logged finding and fixes it on the next save. Failing every rebuild over
        // one is the worst dev loop for a codegen-first framework, and it is not
        // what `vite dev` does either.
        if (!watching && blockingMessage !== undefined) {
            this.#findings.push(new Error(blockingMessage));
        }
    }

    /** The nearest `tsconfig.json`'s contents, or `""` when the project has none. */
    #readTsconfig(): string {
        const tsconfigPath = findTsconfig(this.#schemaDirectory);

        if (tsconfigPath === undefined || !existsSync(tsconfigPath)) {
            return "";
        }

        try {
            return readFileSync(tsconfigPath, "utf8");
        } catch {
            return "";
        }
    }
}

export { LunoraRspackPlugin, PLUGIN_NAME };
