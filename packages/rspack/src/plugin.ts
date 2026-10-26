import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { findTsconfig, fingerprintSchemaSources, listLunoraSourceFiles, PROJECT_CONFIG_FILENAMES, projectConfigCandidatePaths } from "@lunora/codegen";
import {
    AGENT_RULES_HINT,
    claimAgentRulesHint,
    CODEGEN_ENV,
    createConfirm,
    detectAgentRules,
    ensureDevVariables,
    ensureDevWorkerEnv,
    fillDevSecrets,
    inferLunoraBindings,
    isCodegenDisabled,
    lunoraLine,
    runPostCodegenHook,
    secretSourcesFromBindings,
} from "@lunora/config";
import {
    assertWranglerSatisfiesSchema,
    findWranglerFile,
    reconcileBindingsSafely,
    warnCloudflareCliConfigOnce,
    WRANGLER_FILES,
} from "@lunora/config/cloudflare";

import type { CodegenLogger } from "./codegen";
import { createReusableProject, runCodegenPass } from "./codegen";
import type { CompilationLike, CompilerLike } from "./compiler";
import { resolveRunnableTargetOrThrow } from "./options";
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

/**
 * `path` resolved through symlinks, or `path` itself when that fails. The watcher
 * reports a changed file under its real path (on macOS the temp directory alone is
 * a symlink), so an input is matched in both forms. A path that does not exist yet
 * gets its directory resolved instead.
 */
const realPathOf = (path: string): string => {
    try {
        return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
    } catch {
        return path;
    }
};

/**
 * The `tsconfig.json` paths `findTsconfig` tries before reaching `found`, or up to the
 * filesystem root when it found none. Creating one switches the tsconfig codegen
 * resolves, so each is watched as a missing file.
 */
const nearerTsconfigPaths = (schemaDirectory: string, found: string | undefined): string[] => {
    const paths: string[] = [];

    for (let directory = schemaDirectory; directory !== dirname(directory); directory = dirname(directory)) {
        const candidate = join(directory, "tsconfig.json");

        if (candidate === found) {
            break;
        }

        paths.push(candidate);
    }

    return paths;
};

/**
 * The `package.json` and `.git` paths that decide where `projectConfigCandidatePaths`
 * stops: one of each in every directory it walks. Creating or removing a `package.json`
 * moves that boundary and so changes which `lunora.config.*` codegen reads.
 *
 * ponytail: an existing `.git` is left out, since everything git does happens inside
 * it; deleting one is not seen until the next `lunora/` edit. Watch its parent
 * directory if that ever matters.
 */
const projectBoundaryMarkers = (schemaDirectory: string): string[] =>
    [...new Set(projectConfigCandidatePaths(schemaDirectory).map((path) => dirname(path)))].flatMap((directory) => {
        const git = join(directory, ".git");

        return existsSync(git) ? [join(directory, "package.json")] : [join(directory, "package.json"), git];
    });

/**
 * The real paths of schema sources that are symlinks to files outside the schema
 * directory. Codegen reads them through the link, but the watcher reports their edits
 * under the target, which the directory watch does not cover.
 */
const linkedSourceTargets = (schemaDirectory: string): string[] => {
    if (!existsSync(schemaDirectory)) {
        return [];
    }

    const realDirectory = realPathOf(schemaDirectory);

    return [...listLunoraSourceFiles(schemaDirectory, { includeSkipped: true }), join(schemaDirectory, "schema.ts")]
        .map((path) => realPathOf(path))
        .filter((path) => !path.startsWith(`${realDirectory}${sep}`));
};

/** Whether `changed` is `input`, lies under it, or is a directory holding it — all three mean the input may have moved. */
const touches = (changed: string, input: string): boolean => changed === input || changed.startsWith(`${input}${sep}`) || input.startsWith(`${changed}${sep}`);

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
 * The project's secret sources, read with the schema directory the plugin was given. When its bindings cannot be read, every dev
 * secret is generated as before the sources were passed, so a broken tsconfig or barrel does not stop dev startup.
 */
const secretSourcesOrUndefined = async (
    projectRoot: string,
    schemaDirectory: string,
    info: (message: string) => void,
): Promise<ReadonlyArray<string> | undefined> => {
    try {
        return secretSourcesFromBindings(await inferLunoraBindings({ projectRoot, schemaDir: schemaDirectory }));
    } catch (error) {
        info(`could not read the project's bindings, so every dev secret is generated: ${error instanceof Error ? error.message : String(error)}`);

        return undefined;
    }
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

    const secretSources = await secretSourcesOrUndefined(options.projectRoot, options.schemaDir, info);
    fillDevSecrets({ cwd: options.projectRoot, info, secretSources });
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
    /** Resolved options. The `target` is re-resolved on each pass. */
    #options: ResolvedLunoraRspackOptions;

    /**
     * The target the last codegen pass that actually ran generated for. Unset until
     * one has run. Kept apart from `#options.target`, which moves at the start of a
     * pass whether or not that pass gets as far as generating anything.
     */
    #generatedTarget: string | undefined;

    /** Absolute schema directory — the codegen input, and the watched context. */
    readonly #schemaDirectory: string;

    /** Read once: `LUNORA_CODEGEN` cannot change under a running compiler. */
    readonly #codegenDisabled: boolean;

    /** Reused ts-morph program, refreshed per pass instead of re-parsed. */
    readonly #project: ReturnType<typeof createReusableProject>;

    /** Guards the once-per-session startup work from re-running on every rebuild. */
    #started = false;

    /** Whether this session already warned via {@link #announce} — kept apart from `#started`, which the codegen switches gate. */
    #announced = false;

    /** Content hash of everything codegen reads, from the last pass that ran. */
    #lastFingerprint: string | undefined;

    /** The `tsconfig.json` and `lunora.config.*` contents the cached Project was built from. */
    #lastProjectInputs: string | undefined;

    /** Findings from the last pass that ran, re-reported on every compilation until it runs again. */
    #findings: Error[] = [];

    /** The fingerprint a failing pass keeps being retried on, and how many times. See {@link MAX_FAILED_RETRIES}. */
    #failure: { attempts: number; fingerprint: string } | undefined;

    /** The in-flight pass, so concurrent compilers share one instead of racing. */
    #inFlight: Promise<void> | undefined;

    /**
     * Every path a pass reads, in both the form registered and its real form, as of
     * the last `afterCompile`: the schema directory and each watched config file.
     * What {@link #untouched} matches a rebuild's changed files against.
     */
    #inputs: string[] = [];

    /** {@link linkedSourceTargets} as of the last pass that ran; only a pass can change which sources are linked. */
    #linkedSources: string[] = [];

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
        this.#announce();

        if (this.#started) {
            return;
        }

        this.#started = true;

        await prepareDevSession(this.#options);
    }

    /**
     * Run a watch-mode codegen pass now, ahead of the first compilation.
     *
     * Public for the same ordering reason as {@link prepareDevSession}: the
     * Worker `@lunora/rspack/rsbuild` spawns is bundled by `wrangler dev` at
     * startup, and it imports `_generated/app` — which, on a fresh clone, only
     * this pass writes. Spawned first, wrangler dies on an unresolvable import
     * before the first compilation ever generates it. The first compilation then
     * finds the fingerprint unchanged and skips its own pass.
     *
     * Returns the target that pass generated for, so the Worker started next is the
     * one its output matches. Reading `target` again after this resolves would leave
     * a window in which an edit to `lunora.config.*` starts a Worker against output
     * for the other target.
     */
    public async generateForDev(): Promise<string> {
        await this.#run(true);

        return this.#generatedTarget ?? this.#options.target;
    }

    /** Rspack's plugin entry point. */
    public apply(compiler: CompilerLike): void {
        compiler.hooks.beforeCompile.tapPromise(PLUGIN_NAME, async () => {
            // `watchMode` is read HERE, not at tap time: `apply()` runs inside
            // `createCompiler()`, before `compiler.watch()` assigns it, so at tap
            // time it is always `false`.
            const watching = compiler.watchMode === true;

            // Ahead of the skip below: the warning is asked on every compile until it
            // has fired, and `cloudflare.config.ts` is no input of the pass.
            this.#announce();

            if (watching && this.#untouched(compiler.modifiedFiles, compiler.removedFiles)) {
                return;
            }

            await this.#run(watching);
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
            const tsconfigPath = findTsconfig(this.#schemaDirectory);

            if (tsconfigPath !== undefined) {
                compilation.fileDependencies.add(tsconfigPath);
            }

            // EVERY wrangler and `lunora.config.*` candidate, as `@lunora/vite` does:
            // creating one is an edit too — the fix for "wrangler.jsonc not found", or a
            // `wrangler.jsonc` that now outranks an existing `wrangler.json`. A file
            // dependency cannot name a file that does not exist yet, so an absent
            // candidate is watched as a missing one. The config codegen reads for the
            // schema directory may sit above it, so those candidates are watched too:
            // its `codegen.exclude` decides which `lunora/` files the Project is seeded with.
            const watched = [
                ...WRANGLER_FILES.map((name) => resolve(this.#options.projectRoot, name)),
                ...PROJECT_CONFIG_FILENAMES.map((name) => resolve(this.#options.projectRoot, name)),
                ...projectConfigCandidatePaths(this.#schemaDirectory),
                ...projectBoundaryMarkers(this.#schemaDirectory),
                ...nearerTsconfigPaths(this.#schemaDirectory, tsconfigPath),
                ...this.#linkedSources,
            ];

            for (const path of new Set(watched)) {
                if (existsSync(path)) {
                    compilation.fileDependencies.add(path);
                } else {
                    compilation.missingDependencies.add(path);
                }
            }

            const inputs = [this.#schemaDirectory, ...(tsconfigPath === undefined ? [] : [tsconfigPath]), ...watched];

            this.#inputs = [...new Set([...inputs, ...inputs.map((path) => realPathOf(path))])];

            for (const finding of this.#findings) {
                compilation.errors.push(finding);
            }

            return Promise.resolve();
        });
    }

    /**
     * One instance can be applied to several compilers (an array config, or an
     * Rsbuild with more than one environment), whose `beforeCompile` hooks then
     * interleave. Sharing the in-flight promise keeps that to a single pass
     * rather than duplicated codegen and two concurrent `postcodegen` subprocesses.
     */
    async #run(watching: boolean): Promise<void> {
        this.#inFlight ??= this.#pass(watching).finally(() => {
            this.#inFlight = undefined;
        });

        await this.#inFlight;
    }

    /**
     * Whether a watch rebuild changed nothing a pass reads, so it can skip the pass
     * without even fingerprinting, which reads and hashes every `lunora/` source.
     *
     * Conservative on every axis; any doubt runs the pass, whose fingerprint then
     * decides as before. It runs when there are no change sets (a one-shot build, the
     * first watch compilation) or no compilation has registered the inputs yet; when
     * no clean pass is on record, or a failing one is still being retried — that retry
     * exists because the repair can be external, so it must not wait for an edit; when
     * another compiler's pass is in flight, which this one must wait for; and when any
     * changed or removed path touches an input. Rspack reports an edit under a context
     * dependency as the DIRECTORY, so the schema directory itself is an input.
     */
    #untouched(modified: ReadonlySet<string> | undefined, removed: ReadonlySet<string> | undefined): boolean {
        if (
            modified === undefined ||
            this.#inputs.length === 0 ||
            this.#lastFingerprint === undefined ||
            this.#failure !== undefined ||
            this.#inFlight !== undefined
        ) {
            return false;
        }

        for (const changed of [...modified, ...(removed ?? [])]) {
            if (this.#inputs.some((input) => touches(changed, input))) {
                return false;
            }
        }

        return true;
    }

    /**
     * The first thing a session does, ahead of every codegen and validation
     * switch (`LUNORA_CODEGEN=0`, `validateWrangler: false`, a skipped pass, a
     * failing `.dev.vars` scaffold): warn about a Cloudflare CLI config beside
     * the wrangler config (#964). Runs in watch mode and one-shot builds alike —
     * a build is where someone reaches for `cf deploy` next.
     *
     * Asked on every pass until it has warned, so a `cloudflare.config.ts` added
     * mid-session (`cf migrate` run in another terminal) is caught on the next
     * compile rather than never. The cost stays small: the shared process-tree
     * guard is read before the filesystem probe (so once `lunora dev` or an
     * earlier pass warned, it is an env read), and after this session warned,
     * `#announced` skips even that.
     */
    #announce(): void {
        if (this.#announced) {
            return;
        }

        this.#announced = warnCloudflareCliConfigOnce(this.#options.projectRoot, (message) => {
            consoleLogger.warn(lunoraLine(message));
        });
    }

    /**
     * One startup-or-rebuild pass. `watching` decides only whether a blocking
     * schema advisory is reported as a build error.
     */
    async #pass(watching: boolean): Promise<void> {
        this.#announce();

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

        const projectInputs = this.#readProjectInputs();

        if (projectInputs !== this.#lastProjectInputs) {
            // `refreshCodegenProject` only re-reads files the program already knows
            // about, so a changed `paths`/`include` is invisible to it, and so is a
            // changed `codegen.exclude` in lunora.config (it decides which `lunora/`
            // files the Project is seeded with). Forget the fingerprint too, so this
            // pass runs rather than being skipped below.
            this.#project.drop();
            this.#lastProjectInputs = projectInputs;
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
        const fingerprint = this.#fingerprint(projectInputs);

        if (this.#shouldSkip(fingerprint)) {
            return;
        }

        this.#linkedSources = linkedSourceTargets(this.#schemaDirectory);
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
     * reads, the tsconfig and `lunora.config.*` that decide how they resolve, and
     * the wrangler config that validation checks them against.
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
    #fingerprint(projectInputs: string): string {
        const wranglerPath = findWranglerFile(this.#options.projectRoot);
        const parts = [fingerprintSchemaSources(this.#schemaDirectory), projectInputs, wranglerPath === undefined ? "" : readFileOrEmpty(wranglerPath)];

        return parts.map((part) => createHash("sha256").update(part).digest("hex")).join("");
    }

    /** The pass proper, in the order the steps depend on each other. */
    async #generate(watching: boolean): Promise<void> {
        // Re-resolved on every pass, not kept from construction: a `target` edited in
        // `lunora.config.*` is what triggered this pass, and it must reach codegen and
        // the bindings below. Inside the pass's try, so a bad target is a reported finding.
        this.#options = { ...this.#options, target: resolveRunnableTargetOrThrow(this.#options.projectRoot, this.#options.explicitTarget) };

        // Before validation, and on every pass: provisioning is not validation.
        // The bindings the check below requires are largely the ones Lunora writes
        // here, so validating first fails the first build of any project that
        // declares a `.global()` table or a container. Idempotent.
        await reconcileBindingsSafely(this.#options, consoleLogger);

        if (this.#options.validateWrangler) {
            assertWranglerSatisfiesSchema(this.#options, consoleLogger.warn, "Update your wrangler.jsonc and rebuild.");
        }

        const { blockingMessage, markerFailure } = runCodegenPass(this.#options, consoleLogger, this.#project.get());

        this.#generatedTarget = this.#options.target;
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

        // The CLI's deploy reads this marker to pick the API spec, so a build without it would ship the wrong one.
        if (!watching && markerFailure !== undefined) {
            this.#findings.push(new Error(markerFailure));
        }
    }

    /**
     * What a cached Project is built from: the nearest `tsconfig.json`'s contents, and the
     * contents of every `lunora.config.*` candidate that could govern the schema directory
     * (plus the root's, which sets `target`). An absent candidate contributes its path, so
     * creating one changes the inputs too.
     */
    #readProjectInputs(): string {
        const tsconfigPath = findTsconfig(this.#schemaDirectory);
        const configPaths = new Set([
            ...projectConfigCandidatePaths(this.#schemaDirectory),
            ...PROJECT_CONFIG_FILENAMES.map((name) => resolve(this.#options.projectRoot, name)),
        ]);
        const configs = [...configPaths].map((path) => `${path}\n${readFileOrEmpty(path)}`);

        return [tsconfigPath === undefined ? "" : readFileOrEmpty(tsconfigPath), ...configs].join("\0");
    }
}

export { LunoraRspackPlugin, PLUGIN_NAME };
