import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { assertWranglerSatisfiesSchema, findWranglerFile, reconcileBindingsSafely } from "@lunora/config/cloudflare";

import type { CodegenLogger } from "./codegen";
import { createReusableProject, runCodegenPass } from "./codegen";
import type { CompilationLike, CompilerLike } from "./compiler";
import type { ResolvedLunoraRspackOptions } from "./types";

/** Tap name Rspack attributes this plugin's hooks to, in stats and in profiling output. */
const PLUGIN_NAME = "LunoraRspackPlugin";

/**
 * Consecutive retries allowed for a pass that keeps failing on identical inputs.
 *
 * A failed pass records no fingerprint, so the next compilation retries it — that
 * is what lets a `postcodegen` recover once whatever broke it is repaired, since
 * the repair may be external and move nothing this plugin hashes. Uncapped, that
 * makes every UNRELATED rebuild pay for the whole pass for as long as the failure
 * stands: editing app code with a broken hook re-ran codegen and respawned the
 * hook on every save (measured across four saves: five hook spawns, versus two
 * with this cap).
 *
 * Two, matching `@lunora/vite`'s `MAX_SETTLE_RERUNS`: enough to ride out a
 * transient cause, few enough that a permanently broken hook settles. The finding
 * keeps being reported after the cap — only the re-running stops — and any real
 * edit to the schema, tsconfig or wrangler config moves the fingerprint and
 * rearms it.
 *
 * Note what this is NOT guarding: a failing hook's own write under `_generated/`
 * does not start another compilation. `runPostCodegenHook` is awaited inside
 * `beforeCompile`, so the write lands before that compilation arms its watcher and
 * is absorbed — verified by measuring the build count with this cap present and
 * removed. Guarding a self-triggered spin was the first, wrong reading of this
 * problem, and a test written against it passed either way.
 */
const MAX_FAILED_RETRIES = 2;

/** A file's contents, or `""` when it is absent or unreadable — either way, "nothing to hash". */
const readFileOrEmpty = (path: string): string => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
};

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

    /** The fingerprint a failing pass keeps being retried on, and how many times. See {@link MAX_FAILED_RETRIES}. */
    #failure: { attempts: number; fingerprint: string } | undefined;

    /** The in-flight pass, so concurrent compilers share one instead of racing. */
    #inFlight: Promise<void> | undefined;

    public constructor(options: ResolvedLunoraRspackOptions) {
        this.#options = options;
        this.#schemaDirectory = resolve(options.projectRoot, options.schemaDir);
        this.#codegenDisabled = isCodegenDisabled(process.env[CODEGEN_ENV]);
        this.#project = createReusableProject(this.#schemaDirectory);
    }

    /**
     * Run the once-per-session dev preparation (`.dev.vars` scaffolding, the
     * agent-rules hint) and mark the session started.
     *
     * Public because ORDER matters and only the caller knows it: wrangler reads
     * `.dev.vars` once, while resolving bindings at startup. A host that spawns
     * the Worker — `@lunora/rspack/rsbuild` does, from `onBeforeStartDevServer`,
     * which Rsbuild runs before the first compilation — must therefore await this
     * first, or the very first `rsbuild dev` after a fresh clone boots a Worker
     * with every secret `undefined`. That surfaces as auth failures rather than a
     * clear error, and the SECOND run works, because `.dev.vars` is on disk by
     * then. Neither creating the file nor rewriting `wrangler.jsonc` afterwards
     * rescues the running process.
     *
     * Idempotent: the pass below sees `#started` and skips its own call.
     */
    public async prepareDevSession(): Promise<void> {
        if (this.#started) {
            return;
        }

        this.#started = true;

        await prepareDevSession(this.#options);
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

            // Neither lives under the schema directory, so both need their own
            // registration: a new path alias or `include` changes what codegen
            // resolves, and an edited wrangler config changes what validation
            // accepts. Without these, fixing either one leaves the build showing
            // the stale error until something under `lunora/` happens to change.
            for (const path of [findTsconfig(this.#schemaDirectory), findWranglerFile(this.#options.projectRoot)]) {
                if (path !== undefined) {
                    compilation.fileDependencies.add(path);
                }
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
        const fingerprint = this.#fingerprint(tsconfig);

        if (this.#shouldSkip(fingerprint)) {
            return;
        }

        this.#findings = [];

        try {
            // Inside the try, and before `#started` is set: `.dev.vars` scaffolding
            // reads and writes files, so an unreadable `.dev.vars.example` or a
            // read-only directory would otherwise reject the hook and end the watch
            // session — the one thing this plugin promises never to do. Leaving
            // `#started` unset on failure lets the next rebuild retry it.
            if (!this.#started && watching) {
                await prepareDevSession(this.#options);
            }

            this.#started = true;

            await this.#generate(watching);

            // Recorded only after a CLEAN pass, and deliberately keyed on the
            // findings rather than on whether anything threw: `#generate` REPORTS a
            // `postcodegen` failure instead of throwing, so a throw-only check
            // still pinned the inputs of a failed pass. Either way the effect was
            // the same — the stale finding replayed on every later compilation and
            // nothing short of editing the schema could clear it.
            //
            // A watch-mode schema advisory is not a finding (it is logged, not
            // reported), so a session with a standing advisory still records its
            // fingerprint and does not re-run codegen on every rebuild.
            if (this.#findings.length === 0) {
                this.#lastFingerprint = fingerprint;
                this.#failure = undefined;
            } else {
                this.#recordFailure(fingerprint);
            }
        } catch (error: unknown) {
            // A codegen crash, a wrangler config that cannot satisfy the schema, or
            // a `.dev.vars` that could not be prepared. Reported, not rethrown, so a
            // watch session survives a half-typed schema and regenerates on the next
            // save. The Project is dropped because a run that threw may have left it
            // partially mutated, and the fingerprint stays unset so the next
            // compilation retries rather than replaying this finding forever.
            this.#project.drop();
            this.#lastFingerprint = undefined;
            this.#findings.push(error instanceof Error ? error : new Error(String(error)));
            this.#recordFailure(fingerprint);
            consoleLogger.error(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Whether this compilation can reuse the last pass's outcome.
     *
     * Two ways it can: the last pass succeeded on these exact inputs, or it failed
     * on them and has already been retried to {@link MAX_FAILED_RETRIES}. Skipping
     * never hides anything — `#findings` is re-reported on every compilation
     * either way.
     */
    #shouldSkip(fingerprint: string): boolean {
        if (fingerprint === this.#lastFingerprint) {
            return true;
        }

        return this.#failure !== undefined && this.#failure.fingerprint === fingerprint && this.#failure.attempts >= MAX_FAILED_RETRIES;
    }

    /** Count this pass against {@link MAX_FAILED_RETRIES}, restarting the count when the inputs moved. */
    #recordFailure(fingerprint: string): void {
        this.#failure = this.#failure?.fingerprint === fingerprint ? { attempts: this.#failure.attempts + 1, fingerprint } : { attempts: 1, fingerprint };
    }

    /**
     * Content hash of every input a pass depends on: the schema sources codegen
     * reads, the tsconfig that decides how they resolve, and the wrangler config
     * that validation checks them against.
     *
     * The wrangler config has to be in here. Without it, editing `wrangler.jsonc`
     * in a live session left the fingerprint unchanged, so the next compilation
     * skipped binding reconciliation, validation and codegen entirely — and a
     * changed top-level `vars` never reached the `plaintext_secret_in_wrangler_vars`
     * advisory.
     *
     * Each part is hashed to a fixed-width digest before being combined, so no
     * concatenation of one part's content can impersonate another's.
     */
    #fingerprint(tsconfig: string): string {
        const wranglerPath = findWranglerFile(this.#options.projectRoot);
        const parts = [fingerprintSchemaSources(this.#schemaDirectory), tsconfig, wranglerPath === undefined ? "" : readFileOrEmpty(wranglerPath)];

        return parts.map((part) => createHash("sha256").update(part).digest("hex")).join("");
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

        return tsconfigPath === undefined ? "" : readFileOrEmpty(tsconfigPath);
    }
}

export { LunoraRspackPlugin, PLUGIN_NAME };
