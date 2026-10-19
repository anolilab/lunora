import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import type { DriverToolchain } from "@lunora/config";
import { resolveSchemaDirectory, startDevProcess } from "@lunora/config";
import { detectPackageManager, toolchainExecArgs } from "@lunora/config/cli";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { findWranglerFile, mergeWranglerEnvironment, readWranglerJsonc } from "@lunora/config/cloudflare";

import { sanitizeNamespace } from "../../../../shared/dispatch-namespace";
import { findAvailablePort } from "./free-port";
import type { Logger } from "./logger";

/** First port tried for the throwaway worker; clear of wrangler's own 8787 range so it never collides with `lunora dev`. */
const SMOKE_PORT = 18_787;

/** Upper bound on booting workerd and evaluating every module — a large app takes a while. */
const SMOKE_TIMEOUT_MS = 120_000;

/** Failing modules listed in the error before the rest are summarised. */
const MAX_LISTED_MODULES = 10;

/** Extensions a function module can have; the first one that exists names the file in the error. */
const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".mts", ".ts", ".tsx"]);

/**
 * What a bundled module that reads an import before it is ready looks like. The bundler hoists a
 * circular import instead of raising a TDZ error, so the first symptom is a call on `undefined`,
 * and esbuild prints that as `(void 0)`.
 */
const UNDEFINED_IMPORT_SYMPTOM = /\(void 0\)|is not a function|before initialization|of undefined/u;

interface SmokeLoadOptions {
    /** `src/worker.ts` when the project composes its own entry; otherwise wrangler's `main` is used. */
    composedEntry?: string;
    /** The wrangler config the deploy runs against. */
    configPath?: string;
    cwd: string;
    environment?: string;
    logger: Logger;
    toolchain: DriverToolchain;
}

interface ModuleFailure {
    functionPath: string;
    message: string;
}

const isModuleFailure = (value: unknown): value is ModuleFailure =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as ModuleFailure).functionPath === "string" &&
    typeof (value as ModuleFailure).message === "string";

/**
 * Function paths carry the dispatch namespace, not the file: `billing/invoices.ts` is `billing_invoices` and
 * `ratelimit/index.ts` is `ratelimit`. Map each namespace back to its source file the way codegen derives it.
 */
const functionFilesByNamespace = (cwd: string): Map<string, string> => {
    const schemaDirectory = resolveSchemaDirectory(cwd);
    const files = new Map<string, string>();

    for (const file of readdirSync(join(cwd, schemaDirectory), { recursive: true, encoding: "utf8" })) {
        const extension = extname(file);

        if (MODULE_EXTENSIONS.has(extension) && !file.split(sep).some((part) => part === "_generated" || part === "node_modules")) {
            files.set(sanitizeNamespace(file.slice(0, -extension.length).split(sep).join("/")), join(schemaDirectory, file));
        }
    }

    return files;
};

/** `lunora/posts.ts (list, add): message`, one block per failing module, so a module with ten functions is one entry. */
const formatFailures = (cwd: string, failures: ReadonlyArray<ModuleFailure>): string[] => {
    const files = functionFilesByNamespace(cwd);
    const modules = new Map<string, { exports: string[]; message: string; namespace: string }>();

    for (const { functionPath, message } of failures) {
        const split = functionPath.lastIndexOf(":");
        const namespace = functionPath.slice(0, split);
        const key = `${namespace}\0${message}`;
        const entry = modules.get(key) ?? { exports: [], message, namespace };

        entry.exports.push(functionPath.slice(split + 1));
        modules.set(key, entry);
    }

    return [...modules.values()].map(({ exports, message, namespace }) => {
        const hint = UNDEFINED_IMPORT_SYMPTOM.test(message)
            ? "\n      hint: an import is undefined while this module evaluates — look for a circular import or an export that does not exist"
            : "";

        return `  ${files.get(namespace) ?? namespace} (${exports.join(", ")}): ${message}${hint}`;
    });
};

/**
 * A failed smoke check. `skipped` marks a check that says nothing about the project (something other than
 * the smoke Worker answered): it warns and never blocks. Otherwise the project's modules or entry failed.
 */
class SmokeLoadError extends Error {
    public readonly skipped: boolean;

    public constructor(message: string, skipped = false) {
        super(message);
        this.skipped = skipped;
    }
}

/** `main` and `containers` of the config `deploy` runs against, with `--env` applied the way deploy validation applies it. */
const readWorkerConfig = (cwd: string, environment: string | undefined): { hasContainers: boolean; main: string | undefined } => {
    const wranglerFile = findWranglerFile(cwd);
    const parsed = wranglerFile === undefined ? undefined : readWranglerJsonc<WranglerConfig>(wranglerFile).parsed;

    if (parsed === undefined) {
        return { hasContainers: false, main: undefined };
    }

    const { merged } = mergeWranglerEnvironment(parsed, environment);

    return { hasContainers: (merged.containers ?? []).length > 0, main: merged.main };
};

/** The entry the smoke Worker re-exports, or why there is none. */
const locateSmokeEntry = ({ composedEntry, cwd, environment, toolchain }: SmokeLoadOptions): { main: string } | { skip: string } => {
    if (toolchain.devServer !== "workerd") {
        return { skip: "this deploy target does not run on workerd" };
    }

    const { hasContainers, main: configuredMain } = readWorkerConfig(cwd, environment);
    const main = composedEntry ?? configuredMain;

    if (typeof main !== "string" || main.startsWith("virtual:") || !existsSync(resolve(cwd, main))) {
        return { skip: "the Worker entry is not a file on disk" };
    }

    // `wrangler dev` builds and starts every declared container and has no switch to turn that off.
    return hasContainers ? { skip: "the project declares containers, which `wrangler dev` would build locally before the real container build" } : { main };
};

/**
 * Ask the booted smoke Worker to evaluate every lazy module. A module failure, a Worker that errors
 * with a 5xx after booting, or one that never answers is the project's fault; anything else
 * (a response that is not ours) throws a plain error and the caller skips the check.
 */
const probeLazyModules = async (port: number): Promise<{ checked: number; failures: ModuleFailure[] }> => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/__lunora_smoke_load`, { signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS) }).catch(
        (error: unknown) => {
            if (error instanceof Error && error.name === "TimeoutError") {
                throw new SmokeLoadError(
                    `the smoke Worker booted but did not finish evaluating the lazy modules within ${String(SMOKE_TIMEOUT_MS / 1000)}s — a module may be awaiting something that never settles. Pass --no-smoke-load to ship anyway.`,
                );
            }

            throw error;
        },
    );
    const body = (await response.json().catch(() => undefined)) as Partial<{ checked: number; failures: unknown[] }> | undefined;
    const { checked, failures } = body ?? {};

    if (typeof checked === "number" && Array.isArray(failures) && failures.every((item) => isModuleFailure(item))) {
        return { checked, failures };
    }

    if (response.status >= 500) {
        throw new SmokeLoadError(
            `the smoke Worker booted but failed while evaluating the lazy modules (HTTP ${String(response.status)}). Pass --no-smoke-load to ship anyway.`,
        );
    }

    throw new SmokeLoadError(`unexpected response (HTTP ${String(response.status)})`, true);
};

/**
 * What a failed smoke check means. A failure of the project's modules or entry blocks, with the cause. A
 * check that could not say anything (skipped) warns. Anything else means the Worker did not start, which
 * blocks: a broken entry throws at load time, and that must not ship just because local wrangler could not confirm it.
 */
const reportSmokeError = (error: unknown, output: string[], logger: Logger): string | undefined => {
    if (error instanceof SmokeLoadError && !error.skipped) {
        logger.error(error.message);

        return error.message;
    }

    if (error instanceof SmokeLoadError) {
        logger.warn(`smoke-load skipped: ${error.message}`);

        return undefined;
    }

    const tail = output.slice(-5).join("\n");
    const message = `the smoke Worker did not start (${error instanceof Error ? error.message : String(error)})${tail === "" ? "" : `\n${tail}`}. Fix the entry, or pass --no-smoke-load to ship anyway.`;

    logger.error(message);

    return message;
};

/**
 * A lazy registry defers a module's evaluation errors to its first call. This runs the project's
 * real Worker entry plus `loadAllFunctions()` in workerd (`wrangler dev --local`) and returns an
 * error naming every module that fails to evaluate, so `build` and `deploy` can refuse to ship it.
 *
 * A failure of the project's modules, or a Worker that starts and then fails, blocks. A check that
 * cannot run at all (no resolvable entry, a target that is not workerd, containers) warns and
 * returns `undefined`, because it says nothing about the project. See {@link reportSmokeError}.
 */
const runLazySmokeLoad = async (options: SmokeLoadOptions): Promise<string | undefined> => {
    const { configPath, cwd, environment, logger, toolchain } = options;
    const functionsFile = join(cwd, resolveSchemaDirectory(cwd), "_generated", "functions.ts");

    // The generated output decides, not the flag: `deploy --prebuilt` ships whatever an earlier
    // `build`/`prepare` wrote, and an eager registry has no lazy modules to check.
    if (!existsSync(functionsFile) || !readFileSync(functionsFile, "utf8").includes("export const loadAllFunctions")) {
        return undefined;
    }

    const target = locateSmokeEntry(options);

    if ("skip" in target) {
        logger.warn(`smoke-load skipped: ${target.skip}, so lazy modules are not evaluated before deploy`);

        return undefined;
    }

    const { main } = target;

    const output: string[] = [];
    let directory: string | undefined;

    try {
        // One directory per run, so two commands in the same checkout never share (or delete) an entry.
        mkdirSync(join(cwd, ".lunora"), { recursive: true });
        directory = mkdtempSync(join(cwd, ".lunora", "smoke-"));

        const entry = join(directory, "entry.ts");

        // The project's own entry is re-exported so Durable Object classes and bindings resolve exactly as in production.
        writeFileSync(
            entry,
            `export * from ${JSON.stringify(resolve(cwd, main))};
import { loadAllFunctions } from ${JSON.stringify(functionsFile)};

export default {
    async fetch() {
        return Response.json(await loadAllFunctions());
    },
};
`,
        );

        const port = await findAvailablePort(SMOKE_PORT);
        // `--local-protocol http`: a config that sets `dev.local_protocol` to https would otherwise refuse the plain-http probe.
        // Paths go in relative to `cwd`: on Windows the child runs through a shell that does not quote an absolute path containing a space.
        const { args, command } = toolchainExecArgs(
            detectPackageManager(cwd),
            toolchain.dev({
                configPath: configPath === undefined ? undefined : relative(cwd, configPath),
                environment,
                extraArgs: [relative(cwd, entry), "--local", "--local-protocol", "http", "--ip", "127.0.0.1", "--port", String(port)],
            }),
        );

        logger.info("smoke-loading lazy function modules in workerd");

        const server = await startDevProcess({
            args,
            command,
            cwd,
            label: "wrangler dev (smoke-load)",
            notFound: "`wrangler` was not found",
            onLine: (line) => {
                output.push(line);
            },
            port,
            readyTimeoutMs: SMOKE_TIMEOUT_MS,
            shell: process.platform === "win32",
        });

        try {
            const { checked, failures } = await probeLazyModules(port);

            if (failures.length === 0) {
                logger.success(`${String(checked)} lazy function(s) evaluate cleanly`);

                return undefined;
            }

            const lines = formatFailures(cwd, failures);
            const more = lines.length > MAX_LISTED_MODULES ? [`  …and ${String(lines.length - MAX_LISTED_MODULES)} more module(s)`] : [];

            throw new SmokeLoadError(
                [
                    `${String(failures.length)} of ${String(checked)} lazy function(s) fail to load:`,
                    ...lines.slice(0, MAX_LISTED_MODULES),
                    ...more,
                    "Fix the module, or pass --no-smoke-load to ship anyway.",
                ].join("\n"),
            );
        } finally {
            await server.stop();
        }
    } catch (error) {
        return reportSmokeError(error, output, logger);
    } finally {
        if (directory !== undefined) {
            try {
                rmSync(directory, { force: true, recursive: true });
            } catch {
                // A handle on Windows can outlive `stop()`; the directory sits under the gitignored `.lunora/`, so leaving it costs nothing.
            }
        }
    }
};

export default runLazySmokeLoad;
