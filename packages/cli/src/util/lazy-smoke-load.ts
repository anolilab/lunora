import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { DevProcess, DevProcessOptions, DevProcessSpawner, DriverToolchain } from "@lunora/config";
import { acceptsConnection, resolveSchemaDirectory, startDevProcess } from "@lunora/config";
import { detectPackageManager, toolchainExecArgs } from "@lunora/config/cli";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { bindingsNeedingDatabase, findWranglerFile, mergeWranglerEnvironment, readWranglerJsonc } from "@lunora/config/cloudflare";

import { sanitizeNamespace } from "../../../../shared/dispatch-namespace";
import { findAvailablePort } from "./free-port";
import type { Logger } from "./logger";

/** First port tried for the throwaway worker; clear of wrangler's own 8787 range so it never collides with `lunora dev`. */
const SMOKE_PORT = 18_787;

/** Ports tried before giving up when another run's Worker answers the probe. */
const SMOKE_PORT_ATTEMPTS = 3;

/** Upper bound on booting workerd and evaluating every module — a large app takes a while. */
const SMOKE_TIMEOUT_MS = 120_000;

/** How long a stopped smoke process tree gets to exit on SIGTERM before SIGKILL. */
const GROUP_STOP_MS = 5000;

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
    /** Starts the dev process. Defaults to a real `wrangler dev`; a caller that must not launch a server passes its own. */
    launcher?: DevProcessSpawner;
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
    let entries: string[];

    try {
        entries = readdirSync(join(cwd, schemaDirectory), { recursive: true, encoding: "utf8" });
    } catch {
        // Unreadable directory: the failures still print, by namespace, and the failing modules stay listed.
        return files;
    }

    for (const file of entries) {
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
            ? "\n      hint: if this module is part of a circular import, an import it reads is still undefined while it evaluates"
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
const locateSmokeEntry = ({ composedEntry, configPath, cwd, environment, toolchain }: SmokeLoadOptions): { main: string } | { skip: string } => {
    if (toolchain.devServer !== "workerd") {
        return { skip: "this deploy target does not run on workerd" };
    }

    const { hasContainers, main: configuredMain } = readWorkerConfig(cwd, environment);
    const main = composedEntry ?? configuredMain;

    if (typeof main !== "string" || main.startsWith("virtual:") || !existsSync(resolve(cwd, main))) {
        return { skip: "the Worker entry is not a file on disk" };
    }

    // `wrangler dev` builds and starts every declared container and has no switch to turn that off.
    if (hasContainers) {
        return { skip: "the project declares containers, which `wrangler dev` would build locally before the real container build" };
    }

    // `wrangler dev` refuses a Hyperdrive binding with no local database. `lunora dev` embeds one for itself; the check does not.
    const unbacked = bindingsNeedingDatabase(cwd, process.env, environment, configPath);

    return unbacked.length === 0 ? { main } : { skip: `the Hyperdrive binding ${unbacked.join(", ")} has no local database for wrangler dev` };
};

/**
 * Ask the booted smoke Worker to evaluate every lazy module. A module failure, a Worker that errors
 * with a 5xx after booting, one that never answers, or one that answers with something that is not the
 * probe's result is the project's fault and blocks. Only a result from another run's Worker is passed over (`undefined`).
 */
const probeLazyModules = async (port: number, runId: string, deadline: number): Promise<{ checked: number; failures: ModuleFailure[] } | undefined> => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/_lunora/__smoke_load`, {
        signal: AbortSignal.timeout(Math.max(0, deadline - Date.now())),
    }).catch((error: unknown) => {
        if (error instanceof Error && error.name === "TimeoutError") {
            throw new SmokeLoadError(
                `the smoke Worker booted but did not finish evaluating the lazy modules within ${String(SMOKE_TIMEOUT_MS / 1000)}s — a module may be awaiting something that never settles. Pass --no-smoke-load to ship anyway.`,
            );
        }

        throw error;
    });
    if (response.status >= 500) {
        throw new SmokeLoadError(
            `the smoke Worker booted but failed while evaluating the lazy modules (HTTP ${String(response.status)}). Pass --no-smoke-load to ship anyway.`,
        );
    }

    const text = await response.text().catch(() => "");
    let body: Partial<{ checked: number; failures: unknown[]; run: unknown }> | undefined;

    try {
        body = JSON.parse(text) as Partial<{ checked: number; failures: unknown[]; run: unknown }>;
    } catch {
        body = undefined;
    }

    const { checked, failures, run } = body ?? {};

    if (typeof checked === "number" && Array.isArray(failures) && failures.every((item) => isModuleFailure(item))) {
        // Another run's Worker bound this port first: `startDevProcess` saw a listener, not our child. Not this project's answer, so `undefined`.
        return run === runId ? { checked, failures } : undefined;
    }

    // Not ours and not another run's: the project's routes answered in front of the Worker, so the project cannot ship as it is.
    const contentType = response.headers.get("content-type") ?? "no content type";
    const snippet = text.replaceAll(/\s+/gu, " ").trim().slice(0, 120);

    throw new SmokeLoadError(
        `the smoke Worker answered with something other than the probe's result (HTTP ${String(response.status)}, ${contentType}${snippet === "" ? "" : `: ${snippet}`}). ` +
            "A route that does not send /_lunora/* to the Worker first answers with the app's assets, so check run_worker_first. Pass --no-smoke-load to ship anyway.",
    );
};

/** A `wrangler dev` started in a process group of its own, so the whole tree can be signalled together. */
interface SmokeGroup {
    /** Removes the handlers that kill the group if the CLI exits or is interrupted first. */
    dispose: () => void;
    /** The group id, which is the pid of the process that leads it. */
    pid: number;
}

/** A group leader's pid is the group id, and a group with no members left is an error to signal, not a failure. */
const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
        process.kill(-pid, signal);
    } catch {
        // ESRCH: nothing is left in the group.
    }
};

const groupAlive = (pid: number): boolean => {
    try {
        process.kill(-pid, 0);

        return true;
    } catch {
        return false;
    }
};

/**
 * Kills the group if the CLI exits, or is interrupted, before the check stops it. Interrupts are re-raised once the group
 * is gone, so the CLI still dies with the signal it was sent.
 */
const killGroupOnExit = (pid: number): (() => void) => {
    const kill = (): void => {
        signalGroup(pid, "SIGKILL");
    };
    // A `once` listener is gone by the time it runs, so re-raising the signal reaches the default action.
    const onSignal = (signal: NodeJS.Signals): void => {
        kill();
        process.kill(process.pid, signal);
    };
    const dispose = (): void => {
        process.removeListener("exit", kill);
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
    };

    process.once("exit", kill);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    return dispose;
};

/**
 * `stop()` signals only the package-manager process it spawned, and the `wrangler` under it can outlive that and keep
 * serving after the run directory is gone. Stopping the whole group clears the tree: SIGTERM, then SIGKILL past the grace.
 */
const stopSmokeGroup = async (group: SmokeGroup | undefined): Promise<void> => {
    if (group === undefined) {
        return;
    }

    group.dispose();

    const { pid } = group;

    signalGroup(pid, "SIGTERM");

    const deadline = Date.now() + GROUP_STOP_MS;

    while (groupAlive(pid) && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling for the group to exit is sequential by nature
        await delay(50);
    }

    if (groupAlive(pid)) {
        signalGroup(pid, "SIGKILL");
    }
};

/**
 * Starts `wrangler dev`. `startDevProcess` rejects when the child exits before it is ready, and `wrangler` exits when its
 * port is already bound. If something listens on that port, another run holds it: `undefined` asks for the next port.
 * With nothing listening, the failure is this run's own and is rethrown.
 */
const startSmokeServer = (options: DevProcessOptions): Promise<DevProcess | undefined> =>
    startDevProcess(options).catch(async (error: unknown) => {
        if (await acceptsConnection(options.port)) {
            return undefined;
        }

        throw error;
    });

/** Logs a clean probe, or throws the list of modules the project has to fix. */
const reportProbe = (cwd: string, { checked, failures }: { checked: number; failures: ModuleFailure[] }, logger: Logger): void => {
    if (failures.length === 0) {
        logger.success(`${String(checked)} lazy function(s) evaluate cleanly`);

        return;
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
};

/**
 * What a failed smoke check means. A failure of the project's modules or entry blocks, with the cause. A
 * check that could not say anything (skipped) warns. Anything else means the Worker did not start, which
 * blocks: a broken entry throws at load time, and that must not ship just because local wrangler could not confirm it.
 * Wrangler can also fail for reasons outside the project (a remote-only binding, a missing assets directory), so the
 * message names both causes.
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
    const message =
        `the smoke Worker did not start (${error instanceof Error ? error.message : String(error)})${tail === "" ? "" : `\n${tail}`}. ` +
        "Either the entry fails when it loads, or local wrangler cannot run the project (a remote-only binding or a missing assets directory). " +
        "Fix whichever it is, or pass --no-smoke-load to ship anyway.";

    logger.error(message);

    return message;
};

/** A directory of its own for one run, so two commands in the same checkout never share (or delete) an entry or its state. */
const createRunDirectory = (cwd: string): string => {
    try {
        mkdirSync(join(cwd, ".lunora"), { recursive: true });

        return mkdtempSync(join(cwd, ".lunora", "smoke-"));
    } catch (error) {
        throw new SmokeLoadError(`could not create a directory for the check (${error instanceof Error ? error.message : String(error)})`, true);
    }
};

/**
 * Write the re-export entry and the `wrangler dev` command for one run. Failing here is the check's problem, not the
 * project's: it says nothing about the modules, so it is reported as skipped rather than as a failed Worker start.
 */
const prepareSmokeProcess = async (input: {
    configPath: string | undefined;
    cwd: string;
    directory: string;
    environment: string | undefined;
    functionsFile: string;
    main: string;
    /** The first port to try; a retry starts above the port another run's Worker held. */
    preferred: number;
    toolchain: DriverToolchain;
}): Promise<{ args: string[]; command: string; port: number; runId: string }> => {
    const { configPath, cwd, directory, environment, functionsFile, main, preferred, toolchain } = input;

    try {
        const entry = join(directory, "entry.ts");
        // Echoed back by the probe, so an answer from another run's Worker on the same port is recognised.
        const runId = randomUUID();

        // The project's own entry is re-exported so Durable Object classes and bindings resolve exactly as in production.
        writeFileSync(
            entry,
            `export * from ${JSON.stringify(resolve(cwd, main))};
import { loadAllFunctions } from ${JSON.stringify(functionsFile)};

const runId = ${JSON.stringify(runId)};

export default {
    async fetch() {
        return Response.json({ ...(await loadAllFunctions()), run: runId });
    },
};
`,
        );

        const port = await findAvailablePort(preferred);

        // `--local-protocol http`: a config that sets `dev.local_protocol` to https would otherwise refuse the plain-http probe.
        // Paths go in relative to `cwd`: on Windows the child runs through a shell that does not quote an absolute path containing a space.
        // `--persist-to` keeps the check's storage out of the `.wrangler/state` that `lunora dev` uses, and is removed with the run.
        const { args, command } = toolchainExecArgs(
            detectPackageManager(cwd),
            toolchain.dev({
                configPath: configPath === undefined ? undefined : relative(cwd, configPath),
                environment,
                extraArgs: [
                    relative(cwd, entry),
                    "--local",
                    "--local-protocol",
                    "http",
                    "--ip",
                    "127.0.0.1",
                    "--port",
                    String(port),
                    "--persist-to",
                    relative(cwd, join(directory, "state")),
                ],
            }),
        );

        return { args, command, port, runId };
    } catch (error) {
        throw new SmokeLoadError(`could not prepare the check (${error instanceof Error ? error.message : String(error)})`, true);
    }
};

/**
 * A lazy registry defers a module's evaluation errors to its first call. This runs the project's
 * real Worker entry plus `loadAllFunctions()` in workerd (`wrangler dev --local`) and returns an
 * error naming every module that fails to evaluate, so `build` and `deploy` can refuse to ship it.
 *
 * A failure of the project's modules blocks. So does a Worker that does not start (a broken entry, or a local
 * `wrangler dev` that cannot run the project) or that starts and then fails. A check that cannot run at all
 * (no resolvable entry, a target that is not workerd, containers, a Hyperdrive binding with no local database,
 * or a run directory or command that cannot be prepared) warns and returns `undefined`, because it says nothing
 * about the project. See {@link reportSmokeError}.
 */
const runLazySmokeLoad = async (options: SmokeLoadOptions): Promise<string | undefined> => {
    const { configPath, cwd, environment, launcher, logger, toolchain } = options;
    const functionsFile = join(cwd, resolveSchemaDirectory(cwd), "_generated", "functions.ts");

    // The generated output decides, not the flag: `deploy --prebuilt` ships whatever an earlier
    // `build` wrote, and an eager registry has no lazy modules to check.
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
    let group: SmokeGroup | undefined;
    // One budget for booting and evaluating: a slow boot leaves less time for the probe, not a second full allowance.
    const deadline = Date.now() + SMOKE_TIMEOUT_MS;

    // Only when the caller did not inject a launcher. Windows has no process groups to signal, so it spawns plainly.
    const grouped = process.platform !== "win32";
    const spawnInGroup: DevProcessSpawner = (command, args, spawnOptions) => {
        const child = spawn(command, [...args], { cwd: spawnOptions.cwd, detached: grouped, shell: spawnOptions.shell, stdio: ["ignore", "pipe", "pipe"] });

        if (grouped && child.pid !== undefined) {
            group = { dispose: killGroupOnExit(child.pid), pid: child.pid };
        }

        return child;
    };

    try {
        directory = createRunDirectory(cwd);

        logger.info("smoke-loading lazy function modules in workerd");

        // The free-port check and `wrangler dev`'s bind are not atomic, so another run can take the port in between.
        // Its Worker then answers the probe; that attempt is dropped and retried on the next port.
        let preferred = SMOKE_PORT;

        for (let attempt = 0; attempt < SMOKE_PORT_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each attempt starts above the port the previous one found taken
            const { args, command, port, runId } = await prepareSmokeProcess({
                configPath,
                cwd,
                directory,
                environment,
                functionsFile,
                main,
                preferred,
                toolchain,
            });

            preferred = port + 1;

            // eslint-disable-next-line no-await-in-loop -- one wrangler at a time: the next attempt depends on this one's port
            const server = await startSmokeServer({
                args,
                command,
                cwd,
                spawn: launcher ?? spawnInGroup,
                label: "wrangler dev (smoke-load)",
                notFound: "`wrangler` was not found",
                onLine: (line) => {
                    output.push(line);
                },
                port,
                readyTimeoutMs: Math.max(0, deadline - Date.now()),
                shell: process.platform === "win32",
            });

            if (server === undefined) {
                // eslint-disable-next-line no-await-in-loop -- the next attempt must not start while this tree still holds the port
                await stopSmokeGroup(group);
                group = undefined;

                continue;
            }

            try {
                // eslint-disable-next-line no-await-in-loop -- the probe decides whether this attempt stands
                const probed = await probeLazyModules(port, runId, deadline);

                if (probed !== undefined) {
                    reportProbe(cwd, probed, logger);

                    return undefined;
                }
            } finally {
                // eslint-disable-next-line no-await-in-loop -- the next attempt must not start while this tree still holds its port
                await server.stop();
                // eslint-disable-next-line no-await-in-loop -- the next attempt must not start while this tree still holds its port
                await stopSmokeGroup(group);
                group = undefined;
            }
        }

        throw new SmokeLoadError(`the smoke port was answered by other runs on all ${String(SMOKE_PORT_ATTEMPTS)} attempts`, true);
    } catch (error) {
        return reportSmokeError(error, output, logger);
    } finally {
        // The tree is stopped before the run directory it runs out of is removed.
        await stopSmokeGroup(group);

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
