import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import type { DevProcess, DevProcessOptions, DevProcessSpawner, DriverToolchain } from "@lunora/config";
import { acceptsConnection, resolveSchemaDirectory, startDevProcess } from "@lunora/config";
import { detectPackageManager, toolchainExecArgs } from "@lunora/config/cli";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { bindingsNeedingDatabase, findWranglerFile, mergeWranglerEnvironment, readWranglerJsonc } from "@lunora/config/cloudflare";

import { sanitizeNamespace } from "../../../../shared/dispatch-namespace";
import { generatedConfigPath } from "../commands/deploy/hyperdrive";
import { findAvailablePort } from "./free-port";
import collectIntegrationModules from "./integration-modules";
import literal from "./js-literal";
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

/** What the smoke Worker reports: the lazy functions covered, the deferred event modules covered, and what failed. */
interface ProbeResult {
    checked: number;
    deferredChecked: number;
    failures: ModuleFailure[];
    integrations: { checked: number; failures: IntegrationFailure[] };
}

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
    /**
     * Set on a failing deferred event module (`queue`, `workflow` or `agent`); `functionPath` is then
     * `<kind>:<file>` rather than `<namespace>:<export>`. Function failures never carry it.
     */
    deferred?: DeferredKind;
    functionPath: string;
    message: string;
}

/** The generated modules a lazy build loads with `import()` on an event rather than at startup. */
type DeferredKind = "agent" | "module" | "queue" | "workflow";

interface DeferredModule {
    /** Absolute path the probe imports. */
    file: string;
    kind: DeferredKind;
    /** Project-relative path, for the error message. */
    label: string;
}

interface IntegrationFailure {
    message: string;
    specifier: string;
}

const isModuleFailure = (value: unknown): value is ModuleFailure =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as ModuleFailure).functionPath === "string" &&
    ((value as ModuleFailure).deferred === undefined || ["agent", "module", "queue", "workflow"].includes((value as ModuleFailure).deferred as string)) &&
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

const hintFor = (message: string): string =>
    UNDEFINED_IMPORT_SYMPTOM.test(message)
        ? "\n      hint: if this module is part of a circular import, an import it reads is still undefined while it evaluates"
        : "";

/** `lunora/posts.ts (list, add): message`, one block per failing module, so a module with ten functions is one entry. */
const formatFailures = (cwd: string, failures: ReadonlyArray<ModuleFailure>): string[] => {
    const files = functionFilesByNamespace(cwd);
    const modules = new Map<string, { exports: string[]; message: string; namespace: string }>();
    const deferredLines: string[] = [];

    for (const { deferred, functionPath, message } of failures) {
        if (deferred !== undefined) {
            deferredLines.push(`  ${functionPath.slice(deferred.length + 1)} (${deferred}): ${message}${hintFor(message)}`);

            continue;
        }

        const split = functionPath.lastIndexOf(":");
        const namespace = functionPath.slice(0, split);
        const key = `${namespace}\0${message}`;
        const entry = modules.get(key) ?? { exports: [], message, namespace };

        entry.exports.push(functionPath.slice(split + 1));
        modules.set(key, entry);
    }

    return [
        ...[...modules.values()].map(
            ({ exports, message, namespace }) => `  ${files.get(namespace) ?? namespace} (${exports.join(", ")}): ${message}${hintFor(message)}`,
        ),
        ...deferredLines,
    ];
};

/** The first existing `<base><ext>` or `<base>/index<ext>`, the way the generated `../workflows.js` import resolves to source. */
const resolveSourceModule = (base: string): string | undefined => {
    for (const extension of MODULE_EXTENSIONS) {
        for (const candidate of [`${base}${extension}`, join(base, `index${extension}`)]) {
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return undefined;
};

/**
 * The modules the generated output loads with `import()` on an event: the push-queue registry and the
 * email-agent definitions (both in `app.ts`), the workflow definitions (`workflows.ts`) and the agent
 * definitions (`agents.ts`). The generated text decides, not the flag, as for the function manifest. A
 * module an eager build imports statically is evaluated at startup already, so it is never listed.
 */
const findDeferredModules = (cwd: string, schemaDirectory: string): DeferredModule[] => {
    const generated = join(cwd, schemaDirectory, "_generated");
    const read = (name: string): string => {
        try {
            return readFileSync(join(generated, name), "utf8");
        } catch {
            return "";
        }
    };
    const app = read("app.ts");
    const found: DeferredModule[] = [];
    const add = (kind: DeferredKind, file: string | undefined): void => {
        if (file !== undefined) {
            found.push({ file, kind, label: relative(cwd, file).split(sep).join("/") });
        }
    };

    if (app.includes('import("./queues.js")')) {
        add("queue", resolveSourceModule(join(generated, "queues")));
    }

    if (read("workflows.ts").includes('import("../workflows.js")')) {
        add("workflow", resolveSourceModule(join(cwd, schemaDirectory, "workflows")));
    }

    if (read("agents.ts").includes('import("../agents.js")') || app.includes('import("../agents.js")')) {
        add("agent", resolveSourceModule(join(cwd, schemaDirectory, "agents")));
    }

    return found;
};

/** The `.js` a generated relative specifier carries for the `.ts` source beside it. */
const JS_EXTENSION = /\.[cm]?js$/u;

/**
 * A value-position `import("<specifier>")`, which is how every lazy loader the generator emits pulls a module in
 * (`await import(…)`, `() => import(…)`, `import(…).then(…)`, an element of `Promise.all([…])`). A type-position
 * `import("./dataModel.js").Doc` is followed by a member access other than a promise method and never matches.
 */
const LOADER_IMPORT = /(?:await|=>|return|[=[,])\s*import\(\s*"([^"]+)"\s*\)(?!\s*\.(?!(?:then|catch|finally)\b))/gu;

/**
 * Every other module a generated lazy loader evaluates on first use: the inbound email runtime, MCP, payment,
 * browser, the spec and auth modules, and whatever codegen adds next. Read from the emitted `_generated/*.ts`
 * rather than listed here, so a new loader is covered without touching this file. The function manifest's own
 * loaders (`functions.ts`) are checked by `loadAllFunctions`, and `known` holds the modules already listed.
 */
const findLoaderImports = (cwd: string, schemaDirectory: string, known: ReadonlyArray<DeferredModule>): DeferredModule[] => {
    const generated = join(cwd, schemaDirectory, "_generated");
    const seen = new Set(known.map((module) => module.file));
    const found: DeferredModule[] = [];
    let names: string[];

    try {
        names = readdirSync(generated).filter((name) => name.endsWith(".ts") && name !== "functions.ts");
    } catch {
        return found;
    }

    for (const name of names.toSorted((a, b) => a.localeCompare(b))) {
        for (const match of readFileSync(join(generated, name), "utf8").matchAll(LOADER_IMPORT)) {
            const specifier = match[1] ?? "";
            const isRelative = specifier.startsWith(".");
            // A generated `./x.js` names the `./x.ts` source; a bare specifier resolves from the project like the generated file's does.
            const file = isRelative ? resolveSourceModule(resolve(generated, specifier.replace(JS_EXTENSION, ""))) : specifier;

            if (file !== undefined && !seen.has(file)) {
                seen.add(file);
                found.push({ file, kind: "module", label: isRelative ? relative(cwd, file).split(sep).join("/") : specifier });
            }
        }
    }

    return found;
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

    if (parsed === undefined) {
        return { durableObjectClasses: [], hasContainers: false, main: undefined, workflowClasses: [] };
    }

    const { merged } = mergeWranglerEnvironment(parsed, environment);
    const ownClasses = (entries: ReadonlyArray<{ class_name?: string; script_name?: string } | null | undefined>): string[] => [
        ...new Set(
            entries.flatMap((entry) =>
                entry?.script_name === undefined && typeof entry?.class_name === "string" && IDENTIFIER.test(entry.class_name) ? [entry.class_name] : [],
            ),
        ),
    ];

    return {
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
 * them), and the check evaluates the modules on their own against the source config.
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

    const { durableObjectClasses, hasContainers, main: configuredMain, workflowClasses } = readWorkerConfig(cwd, environment);
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

/** Evaluates one module on the Worker; its error message, or `undefined` when it loaded. Anything but this run's answer blocks. */
const requestModule = async (input: Parameters<typeof requestStep>[0], runId: string): Promise<string | undefined> => {
    const step = await requestStep(input);
    const message = step.body?.message;

    if (step.body?.run !== runId || (message !== undefined && typeof message !== "string")) {
        throw unexpectedAnswer(step.response, step.text);
    }

    return message;
};

/**
 * Ask the booted smoke Worker to evaluate every lazy module, one request per step, so a step that
 * never settles is named by the timeout. The first request evaluates nothing: it tells a Worker whose
 * runtime never started (wrangler still holds the port) apart from a module that hangs, and another
 * run's Worker on the port (`undefined`) apart from this one. A module failure, a 5xx, a request that
 * never answers, or an answer that is not the probe's is the project's fault and blocks.
 */
const probeLazyModules = async (input: {
    deadline: number;
    deferred: ReadonlyArray<DeferredModule>;
    functions: boolean;
    integrationModules: ReadonlyArray<string>;
    output: ReadonlyArray<string>;
    port: number;
    runId: string;
    startupFailed: AbortSignal;
}): Promise<ProbeResult | undefined> => {
    const { deferred, functions, integrationModules, runId, ...request } = input;
    const ping = await requestStep({ ...request, pending: undefined, query: "step=ping" });

    if (typeof ping.body?.run !== "string") {
        throw unexpectedAnswer(ping.response, ping.text);
    }

    // Another run's Worker bound this port first: `startDevProcess` saw a listener, not our child.
    if (ping.body.run !== runId) {
        return undefined;
    }

    let checked = 0;
    let failures: ModuleFailure[] = [];

    if (functions) {
        const step = await requestStep({ ...request, pending: "the lazy function modules", query: "step=functions" });
        const { checked: count, failures: found } = step.body ?? {};

        if (typeof count !== "number" || !Array.isArray(found) || !found.every((item) => isModuleFailure(item))) {
            throw unexpectedAnswer(step.response, step.text);
        }

        checked = count;
        failures = found;
    }

    for (const [index, module] of deferred.entries()) {
        // eslint-disable-next-line no-await-in-loop -- one module per request, so a timeout names the module that hangs
        const message = await requestModule(
            { ...request, pending: `${module.kind} module ${module.label}`, query: `step=deferred&index=${String(index)}` },
            runId,
        );

        if (message !== undefined) {
            failures.push({ deferred: module.kind, functionPath: `${module.kind}:${module.label}`, message });
        }
    }

    const integrationFailures: IntegrationFailure[] = [];

    for (const specifier of integrationModules) {
        // eslint-disable-next-line no-await-in-loop -- one module per request, so a timeout names the module that hangs
        const message = await requestModule(
            { ...request, pending: `import(${JSON.stringify(specifier)})`, query: new URLSearchParams({ specifier, step: "integration" }).toString() },
            runId,
        );

        if (message !== undefined) {
            integrationFailures.push({ message, specifier });
        }
    }

    return { checked, deferredChecked: deferred.length, failures, integrations: { checked: integrationModules.length, failures: integrationFailures } };
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

/** What was covered, for the success line: only the kinds the project has. */
const describeCovered = ({ checked, deferredChecked, integrations }: ProbeResult): string =>
    [
        `${String(checked)} lazy function(s)`,
        ...(deferredChecked > 0 ? [`${String(deferredChecked)} deferred module(s)`] : []),
        ...(integrations.checked > 0 ? [`${String(integrations.checked)} integration module(s) loaded with import()`] : []),
    ].join(" and ");

/** Logs a clean probe, or throws the list of modules the project has to fix. */
const reportProbe = (cwd: string, result: ProbeResult, logger: Logger): void => {
    const { checked, deferredChecked, failures, integrations } = result;

    if (failures.length === 0 && integrations.failures.length === 0) {
        logger.success(`${describeCovered(result)} evaluate cleanly`);

        return;
    }

    const lines = formatFailures(cwd, failures);
    const more = lines.length > MAX_LISTED_MODULES ? [`  …and ${String(lines.length - MAX_LISTED_MODULES)} more module(s)`] : [];

    throw new SmokeLoadError(
        [
            ...(failures.length === 0
                ? []
                : [
                      `${String(failures.length)} of ${deferredChecked === 0 ? `${String(checked)} lazy function(s)` : `${String(checked + deferredChecked)} lazy module(s)`} fail to load:`,
                      ...lines.slice(0, MAX_LISTED_MODULES),
                      ...more,
                  ]),
            ...(integrations.failures.length === 0
                ? []
                : [
                      `${String(integrations.failures.length)} of ${String(integrations.checked)} integration module(s) fail to load in workerd (each would fail its first use instead):`,
                      ...integrations.failures.map(({ message, specifier }) => `  import("${specifier}"): ${message}`),
                  ]),
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

/** The top of the smoke entry: the project's entry re-exported, or a stub for each class the config binds. */
const smokeBaseSource = (cwd: string, base: SmokeBase): string => {
    if ("main" in base) {
        return `export * from ${literal(resolve(cwd, base.main))};`;
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
    deferred: ReadonlyArray<DeferredModule>;
    directory: string;
    environment: string | undefined;
    /** The generated `functions.ts`, or `undefined` when it has no lazy manifest to load. */
    functionsFile: string | undefined;
    /** Package specifiers the Worker loads with `import()`, evaluated alongside the lazy modules. */
    integrationModules: ReadonlyArray<string>;
    /** The first port to try; a retry starts above the port another run's Worker held. */
    preferred: number;
    toolchain: DriverToolchain;
}): Promise<{ args: string[]; command: string; port: number; runId: string }> => {
    const { base, configPath, cwd, deferred, directory, environment, functionsFile, integrationModules, preferred, toolchain } = input;

    try {
        const entry = join(directory, "entry.ts");
        // Echoed back by the probe, so an answer from another run's Worker on the same port is recognised.
        const runId = randomUUID();

        // Each integration module gets a literal `import()`, so the bundler resolves and bundles it as the app's own does.
        const loaders = integrationModules.map((specifier) => `    [${literal(specifier)}, () => import(${literal(specifier)})],`).join("\n");

        writeFileSync(
            entry,
            `${smokeBaseSource(cwd, base)}
${functionsFile === undefined ? "" : `import { loadAllFunctions } from ${literal(functionsFile)};\n`}
const runId = ${JSON.stringify(runId)};

// Deferred event modules, evaluated one per request so a module that throws on import blocks like a function module does.
const deferred = [
${deferred.map((module) => `    () => import(${literal(module.file)}),`).join("\n")}
];

const integrationLoaders = new Map<string, () => Promise<unknown>>([
${loaders}
]);

export default {
    async fetch(request: Request) {
        const url = new URL(request.url);
        const step = url.searchParams.get("step");

        if (step === "functions") {
            return Response.json({ ...${functionsFile === undefined ? "{ checked: 0, failures: [] }" : "(await loadAllFunctions())"}, run: runId });
        }

        const load =
            step === "deferred"
                ? deferred[Number(url.searchParams.get("index"))]
                : step === "integration"
                  ? integrationLoaders.get(url.searchParams.get("specifier") ?? "")
                  : undefined;

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
 * A lazy registry defers a module's evaluation errors to its first call, and so does an integration
 * SDK the app hands over as a loader (`() => import("stripe")`), in eager builds too. This runs the
 * project's real Worker entry in workerd (`wrangler dev --local`) with `loadAllFunctions()` (lazy
 * builds) and every package the Worker loads with a literal `import()` (see
 * `collectIntegrationModules`), and returns an error naming every module that fails to evaluate, so
 * `build` and `deploy` can refuse to ship it. An eager app with no such `import()` is not checked.
 *
 * A failure of the project's modules blocks. So does a Worker that does not start (a broken entry, or a local
 * `wrangler dev` that cannot run the project) or that starts and then fails. A check that cannot run at all
 * (no resolvable entry, a target that is not workerd, containers, a Hyperdrive binding with no local database,
 * or a run directory or command that cannot be prepared) warns and returns `undefined`, because it says nothing
 * about the project. See {@link reportSmokeError}.
 */
const runLazySmokeLoad = async (options: SmokeLoadOptions): Promise<string | undefined> => {
    const { composedEntry, cwd, environment, launcher, logger, toolchain } = options;
    const schemaDirectory = resolveSchemaDirectory(cwd);
    const generatedFunctions = join(cwd, schemaDirectory, "_generated", "functions.ts");
    // The generated output decides, not the flag: `deploy --prebuilt` ships whatever an earlier
    // `build`/`prepare` wrote, and an eager registry has no lazy modules to check. A project can defer
    // workflows, agents or queues without a lazy function manifest (it declares no functions), so
    // either one starts the check.
    const hasManifest = existsSync(generatedFunctions) && readFileSync(generatedFunctions, "utf8").includes("export const loadAllFunctions");
    const functionsFile = hasManifest ? generatedFunctions : undefined;
    const events = findDeferredModules(cwd, schemaDirectory);

    // Only lazy output starts the check: an eager build also emits loaders (`auth`, the specs, workflow
    // events) that it is not meant to probe. Once it runs, every loader the generated output reaches is covered.
    if (!hasManifest && events.length === 0) {
        return undefined;
    }

    const deferred = [...events, ...findLoaderImports(cwd, schemaDirectory, events)];

    const target = locateSmokeEntry(options);

    if ("skip" in target) {
        logger.warn(`smoke-load skipped: ${target.skip}, so lazy modules and import()ed integration modules are not evaluated before deploy`);

        return undefined;
    }

    const { base, configFile } = target;
    // Only reached from lazy output (see above); an eager build's loaders are not probed.
    const integrationModules = collectIntegrationModules(cwd, composedEntry ?? readWorkerConfig(cwd, environment).main, schemaDirectory);

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

        logger.info(functionsFile === undefined ? "smoke-loading import()ed integration modules in workerd" : "smoke-loading lazy function modules in workerd");

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
                functionsFile,
                integrationModules,
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
                const probed = await probeLazyModules({
                    deadline,
                    deferred,
                    functions: functionsFile !== undefined,
                    integrationModules,
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

export default runLazySmokeLoad;
