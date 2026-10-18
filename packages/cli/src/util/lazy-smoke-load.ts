import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { DriverToolchain } from "@lunora/config";
import { resolveSchemaDirectory, startDevProcess } from "@lunora/config";
import { detectPackageManager, toolchainExecArgs } from "@lunora/config/cli";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { findAvailablePort } from "./free-port";
import type { Logger } from "./logger";

/** First port tried for the throwaway worker; clear of wrangler's own 8787 range so it never collides with `lunora dev`. */
const SMOKE_PORT = 18_787;

/** Upper bound on booting workerd and evaluating every module — a large app takes a while. */
const SMOKE_TIMEOUT_MS = 120_000;

/** Failing modules listed in the error before the rest are summarised. */
const MAX_LISTED_MODULES = 10;

/** Extensions a function module can have; the first one that exists names the file in the error. */
const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

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

/** `lunora/posts.ts (list, add): message`, one block per failing module, so a module with ten functions is one entry. */
const formatFailures = (cwd: string, failures: ReadonlyArray<ModuleFailure>): string[] => {
    const schemaDirectory = resolveSchemaDirectory(cwd);
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
        const found = MODULE_EXTENSIONS.map((extension) => join(schemaDirectory, `${namespace}${extension}`)).find((file) => existsSync(join(cwd, file)));
        const hint = UNDEFINED_IMPORT_SYMPTOM.test(message)
            ? "\n      hint: an import is undefined while this module evaluates — look for a circular import or an export that does not exist"
            : "";

        return `  ${found ?? namespace} (${exports.join(", ")}): ${message}${hint}`;
    });
};

/**
 * A lazy registry defers a module's evaluation errors to its first call. This runs the project's
 * real Worker entry plus `loadAllFunctions()` in workerd (`wrangler dev --local`) and returns an
 * error naming every module that fails to evaluate, so `build` and `deploy` can refuse to ship it.
 *
 * Only a module failure is an error. When the check itself cannot run — no resolvable entry,
 * wrangler will not boot locally (a remote-only binding, a missing assets directory) — it warns
 * and returns `undefined`: a broken environment must not be mistaken for a broken module.
 */
const runLazySmokeLoad = async (options: SmokeLoadOptions): Promise<string | undefined> => {
    const { composedEntry, configPath, cwd, environment, logger, toolchain } = options;
    const functionsFile = join(cwd, resolveSchemaDirectory(cwd), "_generated", "functions.ts");
    const wranglerFile = findWranglerFile(cwd);
    const main = composedEntry ?? (wranglerFile === undefined ? undefined : readWranglerJsonc<{ main?: string }>(wranglerFile).parsed?.main);

    if (toolchain.devServer !== "workerd") {
        logger.warn("smoke-load skipped: this deploy target does not run on workerd, so lazy modules are not evaluated before deploy");

        return undefined;
    }

    // The generated output decides, not the flag: `deploy --prebuilt` ships whatever an earlier
    // `build`/`prepare` wrote, and an eager registry has no lazy modules to check.
    if (!existsSync(functionsFile) || !readFileSync(functionsFile, "utf8").includes("export const loadAllFunctions")) {
        return undefined;
    }

    if (typeof main !== "string" || main.startsWith("virtual:") || !existsSync(resolve(cwd, main))) {
        logger.warn("smoke-load skipped: the Worker entry is not a file on disk, so lazy modules are not evaluated before deploy");

        return undefined;
    }

    const directory = join(cwd, ".lunora", "smoke");
    const entry = join(directory, "entry.ts");

    mkdirSync(directory, { recursive: true });
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
    const { args, command } = toolchainExecArgs(
        detectPackageManager(cwd),
        toolchain.dev({ configPath, environment, extraArgs: [entry, "--local", "--ip", "127.0.0.1", "--port", String(port)] }),
    );
    const output: string[] = [];
    const isWindows = process.platform === "win32";

    logger.info("smoke-loading lazy function modules in workerd");

    try {
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
            shell: isWindows,
        });

        try {
            const response = await fetch(`http://127.0.0.1:${String(port)}/__lunora_smoke_load`, { signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS) });
            const body = (await response.json()) as Partial<{ checked: number; failures: unknown[] }>;
            const { checked, failures } = body;

            if (typeof checked !== "number" || !Array.isArray(failures) || !failures.every((item) => isModuleFailure(item))) {
                throw new Error(`unexpected response (HTTP ${String(response.status)})`);
            }

            if (failures.length === 0) {
                logger.success(`${String(checked)} lazy function(s) evaluate cleanly`);

                return undefined;
            }

            const lines = formatFailures(cwd, failures);
            const more = lines.length > MAX_LISTED_MODULES ? [`  …and ${String(lines.length - MAX_LISTED_MODULES)} more module(s)`] : [];
            const message = [
                `${String(failures.length)} of ${String(checked)} lazy function(s) fail to load:`,
                ...lines.slice(0, MAX_LISTED_MODULES),
                ...more,
                "Fix the module, or pass --no-smoke-load to ship anyway.",
            ].join("\n");

            logger.error(message);

            return message;
        } finally {
            await server.stop();
        }
    } catch (error) {
        const tail = output.slice(-5).join("\n");

        logger.warn(
            `smoke-load skipped: could not run the Worker locally (${error instanceof Error ? error.message : String(error)})${tail === "" ? "" : `\n${tail}`}`,
        );

        return undefined;
    } finally {
        rmSync(directory, { force: true, recursive: true });
    }
};

export default runLazySmokeLoad;
