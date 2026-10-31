import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import type { DevProcess, DevProcessOptions, DevProcessSpawner, DriverToolchain } from "@lunora/config";
import { acceptsConnection, resolveSchemaDirectory, startDevProcess } from "@lunora/config";
import { detectPackageManager, toolchainExecArgs } from "@lunora/config/cli";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { bindingsNeedingDatabase, findWranglerFile, mergeWranglerEnvironment, readWranglerJsonc } from "@lunora/config/cloudflare";
import { ts } from "ts-morph";

import { sanitizeNamespace } from "../../../../shared/dispatch-namespace";
import { generatedConfigPath } from "../commands/deploy/hyperdrive";
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

/**
 * Generated files whose `import()` calls the Worker runs only once an event arrives, in eager builds too: the auth module,
 * the spec documents, the auth migrator and live-stream mounts in `app.ts`, workflow events in `shard.ts`, and the
 * workflow and agent loaders in `workflows.ts` / `agents.ts`. A file that is absent, or has no `import()`, adds nothing.
 * `functions.ts` is left out: its lazy loaders are covered by `loadAllFunctions`, which reports per function.
 */
const DEFERRING_FILES = ["agents.ts", "app.ts", "shard.ts", "workflows.ts"] as const;

/** Extensions a relative `import()` target written as `./x.js` can have on disk. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"] as const;

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

interface FunctionFailure {
    functionPath: string;
    message: string;
}

/** A deferred module that failed to evaluate, named by its project-relative file or its package specifier. */
interface DeferredFailure {
    message: string;
    module: string;
}

interface ProbeResult {
    checked: number;
    failures: FunctionFailure[];
    modules: { checked: number; failures: DeferredFailure[] };
}

const isFunctionFailure = (value: unknown): value is FunctionFailure =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as FunctionFailure).functionPath === "string" &&
    typeof (value as FunctionFailure).message === "string";

/** A module the generated Worker loads with `import()`: `label` names it in an error, `specifier` is what the smoke entry imports. */
interface DeferredModule {
    label: string;
    specifier: string;
}

/**
 * A relative target is resolved against `_generated/` to the file on disk. A package specifier stays bare: the smoke entry
 * sits under the project's `.lunora/`, so it resolves up to the project's `node_modules` as the generated file's does.
 */
const resolveDeferredModule = (cwd: string, generatedDirectory: string, specifier: string): DeferredModule => {
    if (!specifier.startsWith(".")) {
        return { label: specifier, specifier };
    }

    const target = resolve(generatedDirectory, specifier);
    const stem = target.slice(0, target.length - extname(target).length);
    const file = [target, ...SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`)].find((candidate) => existsSync(candidate)) ?? target;

    return { label: relative(cwd, file).split(sep).join("/"), specifier: file };
};

/**
 * Every `import()` call with a literal target in the generated Worker files. Parsed rather than matched, because the same
 * files carry `import("…").Type` qualifiers in type positions, which load nothing.
 */
const findDeferredModules = (cwd: string, generatedDirectory: string): DeferredModule[] => {
    const found = new Map<string, DeferredModule>();

    for (const name of DEFERRING_FILES) {
        const file = join(generatedDirectory, name);

        if (!existsSync(file)) {
            continue;
        }

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const [argument] = node.arguments;

                if (argument !== undefined && ts.isStringLiteralLike(argument)) {
                    const module = resolveDeferredModule(cwd, generatedDirectory, argument.text);

                    found.set(module.specifier, module);
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
    }

    return [...found.values()];
};

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

const circularImportHint = (message: string): string =>
    UNDEFINED_IMPORT_SYMPTOM.test(message)
        ? "\n      hint: if this module is part of a circular import, an import it reads is still undefined while it evaluates"
        : "";

/** `lunora/posts.ts (list, add): message`, one block per failing module, so a module with ten functions is one entry. */
const formatFailures = (cwd: string, failures: ReadonlyArray<FunctionFailure>): string[] => {
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

    return [...modules.values()].map(
        ({ exports, message, namespace }) => `  ${files.get(namespace) ?? namespace} (${exports.join(", ")}): ${message}${circularImportHint(message)}`,
    );
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

/** A class name that can be written into the smoke entry as an identifier. */
const IDENTIFIER = /^[A-Z_$][\w$]*$/iu;

interface WorkerConfig {
    assetsDirectory: string | undefined;
    /** Durable Object classes this Worker must export itself (bindings without a `script_name`). */
    durableObjectClasses: string[];
    hasContainers: boolean;
    main: string | undefined;
    /** Workflow classes this Worker must export itself. */
    workflowClasses: string[];
}

/** The parts of the config `deploy` runs against that the check needs, with `--env` applied the way deploy validation applies it. */
const readWorkerConfig = (cwd: string, environment: string | undefined): WorkerConfig => {
    const wranglerFile = findWranglerFile(cwd);
    const parsed = wranglerFile === undefined ? undefined : readWranglerJsonc<WranglerConfig>(wranglerFile).parsed;

    if (wranglerFile === undefined || parsed === undefined) {
        return { assetsDirectory: undefined, durableObjectClasses: [], hasContainers: false, main: undefined, workflowClasses: [] };
    }

    const { merged } = mergeWranglerEnvironment(parsed, environment);
    const directory = merged.assets?.directory;
    const ownClasses = (entries: ReadonlyArray<{ class_name?: string; script_name?: string } | null | undefined>): string[] => [
        ...new Set(
            entries.flatMap((entry) =>
                entry?.script_name === undefined && typeof entry?.class_name === "string" && IDENTIFIER.test(entry.class_name) ? [entry.class_name] : [],
            ),
        ),
    ];

    return {
        assetsDirectory: directory === undefined ? undefined : resolve(dirname(wranglerFile), directory),
        durableObjectClasses: ownClasses(merged.durable_objects?.bindings ?? []),
        hasContainers: (merged.containers ?? []).length > 0,
        main: merged.main,
        workflowClasses: ownClasses(merged.workflows ?? []),
    };
};

/**
 * What the smoke entry stands on. Normally it re-exports the project's entry (`main`), so Durable Object
 * classes and bindings resolve exactly as in production.
 *
 * A framework build through the Cloudflare Vite plugin leaves `.wrangler/deploy/config.json`, which
 * sends a `wrangler dev` without `--config` to the built `dist/…/wrangler.json`: `no_bundle`, so the
 * TypeScript smoke entry fails to parse and the runtime never starts. Its source entry cannot be
 * rebuilt outside Vite either (TanStack Start's `#tanstack-router-entry` exists only there). Then the
 * entry exports a stub for each class the config binds instead (wrangler refuses to start without
 * them), and the check evaluates the deferred modules on their own against the source config.
 */
type SmokeBase = { main: string } | { stubs: { durableObjects: string[]; workflows: string[] } };

/** The entry the smoke Worker stands on and the config to run it against, or why there is none. */
const locateSmokeEntry = ({
    composedEntry,
    configPath,
    cwd,
    environment,
    toolchain,
}: SmokeLoadOptions): { base: SmokeBase; configFile: string | undefined } | { skip: string } => {
    if (toolchain.devServer !== "workerd") {
        return { skip: "this deploy target does not run on workerd" };
    }

    const { assetsDirectory, durableObjectClasses, hasContainers, main: configuredMain, workflowClasses } = readWorkerConfig(cwd, environment);
    const main = composedEntry ?? configuredMain;
    // Named explicitly even when the caller did not, so `wrangler dev` never follows a Vite build's redirect.
    const configFile = configPath ?? findWranglerFile(cwd);
    let base: SmokeBase;

    if (configFile !== undefined && generatedConfigPath(configFile) !== undefined) {
        base = { stubs: { durableObjects: durableObjectClasses, workflows: workflowClasses } };
    } else if (typeof main === "string" && !main.startsWith("virtual:") && existsSync(resolve(cwd, main))) {
        base = { main };
    } else {
        return { skip: "the Worker entry is not a file on disk" };
    }

    // `wrangler dev` refuses a missing assets directory, and `deploy` runs the client build that writes it after this check.
    if (assetsDirectory !== undefined && !existsSync(assetsDirectory)) {
        return { skip: `the assets directory ${relative(cwd, assetsDirectory)} does not exist yet (the client build runs after this check)` };
    }

    // `wrangler dev` builds and starts every declared container and has no switch to turn that off.
    if (hasContainers) {
        return { skip: "the project declares containers, which `wrangler dev` would build locally before the real container build" };
    }

    // `wrangler dev` refuses a Hyperdrive binding with no local database. `lunora dev` embeds one for itself; the check does not.
    const unbacked = bindingsNeedingDatabase(cwd, process.env, environment, configPath);

    if (unbacked.length > 0) {
        return { skip: `the Hyperdrive binding ${unbacked.join(", ")} has no local database for wrangler dev` };
    }

    return { base, configFile };
};

/** What wrangler prints for a Worker whose runtime never started; its proxy keeps the port open, so a request would hang instead. */
const RUNTIME_FAILED = /The Workers runtime failed to start|Build failed with \d+ error/u;

/** An error line of wrangler's, or the uncaught exception that keeps workerd from starting. */
const ERROR_LINE = /\[ERROR\]|Uncaught/u;

/** The error lines wrangler printed (or, without any, its last lines), for an error that otherwise has nothing to show. */
const outputTail = (output: ReadonlyArray<string>): string => {
    const lines = output.map((line) => stripVTControlCharacters(line).trim()).filter((line) => line !== "");
    const errors = lines.filter((line) => ERROR_LINE.test(line));
    const shown = errors.length > 0 ? errors.slice(0, 10) : lines.slice(-10);

    return shown.length === 0 ? "" : `\n${shown.map((line) => `  ${line}`).join("\n")}`;
};

/** One request to the smoke Worker, which evaluates `pending` (or nothing, for the first one); the parsed body. */
const requestStep = async (input: {
    deadline: number;
    output: ReadonlyArray<string>;
    pending: string | undefined;
    port: number;
    query: string;
    startupFailed: AbortSignal;
}): Promise<{ body: Record<string, unknown> | undefined; response: Response; text: string }> => {
    const { deadline, output, pending, port, query, startupFailed } = input;
    const response = await fetch(`http://127.0.0.1:${String(port)}/_lunora/__smoke_load?${query}`, {
        signal: AbortSignal.any([AbortSignal.timeout(Math.max(0, deadline - Date.now())), startupFailed]),
    }).catch((error: unknown) => {
        if (startupFailed.aborted) {
            throw new SmokeLoadError(
                `the smoke Worker's runtime did not start, so nothing was evaluated:${outputTail(output)}\nFix the entry, or pass --no-smoke-load to ship anyway.`,
            );
        }

        if (error instanceof Error && error.name === "TimeoutError") {
            throw new SmokeLoadError(
                pending === undefined
                    ? `the smoke Worker accepted the connection but answered no request within ${String(SMOKE_TIMEOUT_MS / 1000)}s, so its runtime did not start:${outputTail(output)}\nPass --no-smoke-load to ship anyway.`
                    : `the smoke Worker did not finish evaluating ${pending} within ${String(SMOKE_TIMEOUT_MS / 1000)}s — it may be awaiting something that never settles. Pass --no-smoke-load to ship anyway.`,
            );
        }

        throw error;
    });

    if (response.status >= 500) {
        throw new SmokeLoadError(
            `the smoke Worker booted but failed while ${pending === undefined ? "answering a request that evaluates nothing" : `evaluating ${pending}`} (HTTP ${String(response.status)}). Pass --no-smoke-load to ship anyway.`,
        );
    }

    const text = await response.text().catch(() => "");
    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        body = undefined;
    }

    return { body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined, response, text };
};

/** Not ours and not another run's: the project's routes answered in front of the Worker, so the project cannot ship as it is. */
const unexpectedAnswer = (response: Response, text: string): SmokeLoadError => {
    const contentType = response.headers.get("content-type") ?? "no content type";
    const snippet = text.replaceAll(/\s+/gu, " ").trim().slice(0, 120);

    return new SmokeLoadError(
        `the smoke Worker answered with something other than the probe's result (HTTP ${String(response.status)}, ${contentType}${snippet === "" ? "" : `: ${snippet}`}). ` +
            "A route that does not send /_lunora/* to the Worker first answers with the app's assets, so check run_worker_first. Pass --no-smoke-load to ship anyway.",
    );
};

/**
 * Ask the booted smoke Worker to evaluate every deferred module, one request per step, so a step that
 * never settles is named by the timeout. The first request evaluates nothing: it tells a Worker whose
 * runtime never started (wrangler still holds the port) apart from a module that hangs, and another
 * run's Worker on the port (`undefined`) apart from this one. A module failure, a 5xx, a request that
 * never answers, or an answer that is not the probe's is the project's fault and blocks.
 */
const probeModules = async (input: {
    deadline: number;
    deferred: ReadonlyArray<DeferredModule>;
    functions: boolean;
    output: ReadonlyArray<string>;
    port: number;
    runId: string;
    startupFailed: AbortSignal;
}): Promise<ProbeResult | undefined> => {
    const { deferred, functions, runId, ...request } = input;
    const ping = await requestStep({ ...request, pending: undefined, query: "step=ping" });

    if (typeof ping.body?.run !== "string") {
        throw unexpectedAnswer(ping.response, ping.text);
    }

    // Another run's Worker bound this port first: `startDevProcess` saw a listener, not our child.
    if (ping.body.run !== runId) {
        return undefined;
    }

    let checked = 0;
    let failures: FunctionFailure[] = [];

    if (functions) {
        const step = await requestStep({ ...request, pending: "the lazy function modules", query: "step=functions" });
        const { checked: count, failures: found } = step.body ?? {};

        if (typeof count !== "number" || !Array.isArray(found) || !found.every((item) => isFunctionFailure(item))) {
            throw unexpectedAnswer(step.response, step.text);
        }

        checked = count;
        failures = found;
    }

    const moduleFailures: DeferredFailure[] = [];

    for (const { label } of deferred) {
        // eslint-disable-next-line no-await-in-loop -- one module per request, so a timeout names the module that hangs
        const step = await requestStep({
            ...request,
            pending: `import(${JSON.stringify(label)})`,
            query: new URLSearchParams({ module: label, step: "module" }).toString(),
        });
        const message = step.body?.message;

        if (step.body?.run !== runId || (message !== undefined && typeof message !== "string")) {
            throw unexpectedAnswer(step.response, step.text);
        }

        if (typeof message === "string") {
            moduleFailures.push({ message, module: label });
        }
    }

    return { checked, failures, modules: { checked: deferred.length, failures: moduleFailures } };
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
const reportProbe = (cwd: string, { checked, failures, modules }: ProbeResult, logger: Logger): void => {
    if (failures.length === 0 && modules.failures.length === 0) {
        const covered = [
            ...(checked > 0 ? [`${String(checked)} lazy function(s)`] : []),
            ...(modules.checked > 0 ? [`${String(modules.checked)} deferred module(s)`] : []),
        ];

        logger.success(`${covered.join(" and ")} evaluate cleanly`);

        return;
    }

    const lines = [...formatFailures(cwd, failures), ...modules.failures.map(({ message, module }) => `  ${module}: ${message}${circularImportHint(message)}`)];
    const more = lines.length > MAX_LISTED_MODULES ? [`  …and ${String(lines.length - MAX_LISTED_MODULES)} more module(s)`] : [];
    const failed = [
        ...(failures.length > 0 ? [`${String(failures.length)} of ${String(checked)} lazy function(s)`] : []),
        ...(modules.failures.length > 0 ? [`${String(modules.failures.length)} of ${String(modules.checked)} deferred module(s)`] : []),
    ];

    throw new SmokeLoadError(
        [
            `${failed.join(" and ")} fail to load:`,
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
 * Wrangler can also fail for reasons outside the project (a remote-only binding), so the
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
        "Either the entry fails when it loads, or local wrangler cannot run the project (a remote-only binding). " +
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

/** The top of the smoke entry: the project's entry re-exported, or a stub for each class the config binds. */
const smokeBaseSource = (cwd: string, base: SmokeBase): string => {
    if ("main" in base) {
        return `export * from ${JSON.stringify(resolve(cwd, base.main))};`;
    }

    const { durableObjects, workflows } = base.stubs;

    return [
        'import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";',
        ...durableObjects.map((name) => `export class ${name} extends DurableObject {}`),
        ...workflows.map((name) => `export class ${name} extends WorkflowEntrypoint { async run() {} }`),
    ].join("\n");
};

/**
 * Write the smoke entry and the `wrangler dev` command for one run. Failing here is the check's problem, not the
 * project's: it says nothing about the modules, so it is reported as skipped rather than as a failed Worker start.
 */
const prepareSmokeProcess = async (input: {
    base: SmokeBase;
    configPath: string | undefined;
    cwd: string;
    /** The modules the generated Worker loads with `import()`, each evaluated by its own `import()` in the probe. */
    deferred: ReadonlyArray<DeferredModule>;
    directory: string;
    environment: string | undefined;
    /** `_generated/functions.ts` when it exports `loadAllFunctions`; an eager registry has no such export to import. */
    lazyFunctionsFile: string | undefined;
    /** The first port to try; a retry starts above the port another run's Worker held. */
    preferred: number;
    toolchain: DriverToolchain;
}): Promise<{ args: string[]; command: string; port: number; runId: string }> => {
    const { base, configPath, cwd, deferred, directory, environment, lazyFunctionsFile, preferred, toolchain } = input;

    try {
        const entry = join(directory, "entry.ts");
        // Echoed back by the probe, so an answer from another run's Worker on the same port is recognised.
        const runId = randomUUID();

        // Deferred modules load through `import()` inside `fetch`, as the app's first event loads them: a static import would
        // evaluate them at startup, turning a per-module report into a Worker that does not start.
        writeFileSync(
            entry,
            `${smokeBaseSource(cwd, base)}
${lazyFunctionsFile === undefined ? "" : `import { loadAllFunctions } from ${JSON.stringify(lazyFunctionsFile)};\n`}
const runId = ${JSON.stringify(runId)};

const deferredModules = new Map<string, () => Promise<unknown>>([
${deferred.map(({ label, specifier }) => `    [${JSON.stringify(label)}, () => import(${JSON.stringify(specifier)})],`).join("\n")}
]);

export default {
    async fetch(request: Request) {
        const url = new URL(request.url);
        const step = url.searchParams.get("step");

        if (step === "functions") {
            return Response.json({ ...${lazyFunctionsFile === undefined ? "{ checked: 0, failures: [] }" : "(await loadAllFunctions())"}, run: runId });
        }

        const load = step === "module" ? deferredModules.get(url.searchParams.get("module") ?? "") : undefined;

        if (load !== undefined) {
            try {
                await load();
            } catch (error) {
                return Response.json({ message: error instanceof Error ? error.message : String(error), run: runId });
            }
        }

        return Response.json({ run: runId });
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
 * A module the Worker loads on demand defers its evaluation errors to the first event that loads it: every lazy
 * function module, and in eager builds too whatever the generated app loads with `import()` (the auth module, the
 * spec documents). This runs the project's real Worker entry in workerd (`wrangler dev --local`), evaluates all of
 * them, and returns an error naming every module that fails, so `build`, `deploy` and `prepare` can refuse to ship it.
 *
 * A failure of the project's modules blocks. So does a Worker that does not start (a broken entry, or a local
 * `wrangler dev` that cannot run the project) or that starts and then fails. A check that cannot run at all
 * (no resolvable entry, a target that is not workerd, containers, a Hyperdrive binding with no local database,
 * or a run directory or command that cannot be prepared) warns and returns `undefined`, because it says nothing
 * about the project. See {@link reportSmokeError}.
 */
const runSmokeLoad = async (options: SmokeLoadOptions): Promise<string | undefined> => {
    const { cwd, environment, launcher, logger, toolchain } = options;
    const generatedDirectory = join(cwd, resolveSchemaDirectory(cwd), "_generated");
    const functionsFile = join(generatedDirectory, "functions.ts");

    // The generated output decides, not the flag: `deploy --prebuilt` ships whatever an earlier
    // `build`/`prepare` wrote. An app with neither a lazy registry nor an `import()` has nothing to check.
    const lazyFunctionsFile =
        existsSync(functionsFile) && readFileSync(functionsFile, "utf8").includes("export const loadAllFunctions") ? functionsFile : undefined;
    const deferred = findDeferredModules(cwd, generatedDirectory);

    if (lazyFunctionsFile === undefined && deferred.length === 0) {
        return undefined;
    }

    const target = locateSmokeEntry(options);

    if ("skip" in target) {
        logger.warn(`smoke-load skipped: ${target.skip}, so deferred modules are not evaluated before deploy`);

        return undefined;
    }

    const { base, configFile } = target;

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

        logger.info("smoke-loading deferred modules in workerd");

        // The free-port check and `wrangler dev`'s bind are not atomic, so another run can take the port in between.
        // Its Worker then answers the probe; that attempt is dropped and retried on the next port.
        let preferred = SMOKE_PORT;

        for (let attempt = 0; attempt < SMOKE_PORT_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each attempt starts above the port the previous one found taken
            const { args, command, port, runId } = await prepareSmokeProcess({
                base,
                configPath: configFile,
                cwd,
                deferred,
                directory,
                environment,
                lazyFunctionsFile,
                preferred,
                toolchain,
            });

            const startupFailed = new AbortController();

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

                    if (RUNTIME_FAILED.test(line)) {
                        startupFailed.abort();
                    }
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
                const probed = await probeModules({
                    deadline,
                    deferred,
                    functions: lazyFunctionsFile !== undefined,
                    output,
                    port,
                    runId,
                    startupFailed: startupFailed.signal,
                });

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

export default runSmokeLoad;
