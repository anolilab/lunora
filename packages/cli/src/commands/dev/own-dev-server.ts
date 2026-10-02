/**
 * `lunora dev` for a target whose toolchain runs its own dev server
 * (`devServer: "own"` — celld): the standalone flavor, with the host's dev
 * server on the projected wrangler config as the worker.
 */
import { dirname } from "node:path";

import { readServiceBindings } from "@lunora/codegen";
import type { DeployDriver } from "@lunora/config";
import { planToolchainInvocation, targetRunsOwnDevServer } from "@lunora/config";

import { detectPackageManager, toolchainExecArgs } from "../../util/detect-package-manager";
import type { ReadinessProbe } from "../../util/dev-probe";
import { defaultProbe, POLL_INTERVAL_MS, resolveReadyTimeoutMs } from "../../util/dev-probe";
import type { Logger } from "../../util/logger";
import type { DevFlavor } from "./lifecycle";
import { codegenRequested } from "./lifecycle";
import type { DevCommandOptions, DevCommandPlan, WorkerSpawner } from "./types";

/**
 * The flavor `lunora dev` actually runs for `target`.
 *
 * A host with its own dev server (celld) has no Vite integration and no
 * framework sidecar: `@lunora/vite` and the sidecar both run the worker in
 * workerd. So it always gets the standalone stack — codegen watch, studio, and
 * the host's dev server as the worker — rather than silently serving a celld
 * app on Cloudflare's runtime.
 */
const resolveTargetFlavor = (target: string, detected: DevFlavor, logger: Logger): DevFlavor => {
    if (!targetRunsOwnDevServer(target)) {
        return detected;
    }

    if (detected !== "wrangler") {
        logger.info(`target ${target} runs its own dev server, so lunora dev serves the worker on it — start the frontend's dev server separately`);
    }

    return "wrangler";
};

/**
 * One dev-server run per `lunora.config` service (plan 457), from the
 * driver's projection of the service's config into `root` — the app
 * projection's directory, whose local state the app resolves its bindings
 * from. Writes the projections. Empty when the driver needs no such step or
 * no service is declared (a declaration codegen rejects is codegen's to report).
 */
const planServiceRegistrations = (inputs: {
    cwd: string;
    driver: DeployDriver;
    manager: ReturnType<typeof detectPackageManager>;
    root: string;
    workerPort: number;
}): NonNullable<DevCommandPlan["serviceRegistrations"]> => {
    const { cwd, driver, manager, root, workerPort } = inputs;
    const { projectServiceConfig, toolchain } = driver;

    if (projectServiceConfig === undefined || toolchain === undefined) {
        return [];
    }

    // Two keys may bind two entrypoints of one Worker: it registers once.
    const workers = [...new Map(readServiceBindings(cwd).services.map((service) => [service.wranglerPath, service])).values()];

    return workers.map((service) => {
        const projected = projectServiceConfig(root, service.wranglerPath);

        projected.write();

        const exec = toolchainExecArgs(manager, toolchain.dev({ configPath: projected.configPath, extraArgs: ["--port", String(workerPort)] }));

        return { args: exec.args, command: exec.command, cwd, name: service.worker, tag: `service:${service.name}` };
    });
};

/** Whether `origin` answers before the deadline, giving up early once the process behind it has exited. */
const waitUntilServing = async (origin: string, probe: ReadinessProbe, exited: Promise<number>): Promise<boolean> => {
    const deadline = Date.now() + resolveReadyTimeoutMs();
    const ended = exited.then(() => "exited" as const);

    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
        const outcome = await Promise.race([probe(origin).then((answered) => (answered ? "ready" : "pending")), ended]);

        if (outcome !== "pending") {
            return outcome === "ready";
        }

        // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
        await new Promise((resolve) => {
            setTimeout(resolve, POLL_INTERVAL_MS);
        });
    }

    return false;
};

/**
 * Boot each service registration until it answers on `origin` — the moment
 * the host has recorded its deployment — then stop it, one at a time on the
 * worker's own port. Returns the error that stops `lunora dev`, if any.
 */
const registerServices = async (inputs: {
    logger: Logger;
    origin: string;
    probe?: ReadinessProbe;
    registrations: NonNullable<DevCommandPlan["serviceRegistrations"]>;
    spawn: WorkerSpawner;
}): Promise<string | undefined> => {
    const { logger, origin, registrations, spawn } = inputs;
    const probe = inputs.probe ?? defaultProbe;

    for (const registration of registrations) {
        logger.info(`registering service ${registration.name} in the local dev state`);

        const child = spawn(registration, logger);
        // eslint-disable-next-line no-await-in-loop -- one registration at a time, on one port
        const ready = await waitUntilServing(origin, probe, child.exited);

        child.kill("SIGTERM");
        // eslint-disable-next-line no-await-in-loop -- the port must be free before the next run
        await child.exited;

        if (!ready) {
            return `service ${registration.name} did not start under the dev server — see its output above`;
        }
    }

    return undefined;
};

/**
 * The plan for a target that runs its own dev server on the projected config
 * (celld): codegen watch and the studio as usual, and the host's dev server as
 * the worker. None of the `wrangler dev`-only machinery applies — no remote
 * bindings, no inspector, no IPv4 loopback fallback. Writes the projection, so
 * it runs after `provisionBindings` has reconciled the config it projects.
 * @throws for `--remote`, which the host has no equivalent for.
 */
const planOwnDevServer = (inputs: {
    cwd: string;
    driver: DeployDriver;
    options: DevCommandOptions;
    studioPort: number;
    workerPort: number;
}): DevCommandPlan => {
    const { cwd, driver, options, studioPort, workerPort } = inputs;
    const { projectConfig, toolchain } = driver;

    if (projectConfig === undefined || toolchain === undefined) {
        throw new Error(`deploy target "${driver.id}" runs its own dev server but ships no config projection or toolchain for it`);
    }

    if (options.remote === true) {
        throw new Error(`--remote proxies bindings to Cloudflare; ${driver.name} has no remote bindings to proxy to`);
    }

    if (options.inspectorPort !== undefined) {
        options.logger.warn(`--inspector-port is a wrangler dev flag; ${driver.name} dev has no inspector to pin`);
    }

    const { command, commit, projection } = planToolchainInvocation(driver, cwd, "dev", (configPath) =>
        toolchain.dev({ configPath, extraArgs: ["--port", String(workerPort)] }),
    );

    commit();

    if (projection !== undefined && projection.dropped.length > 0) {
        options.logger.info(`${driver.name} ignores these wrangler keys, so its dev server runs without them: ${projection.dropped.join(", ")}`);
    }

    const manager = detectPackageManager(cwd);
    const exec = toolchainExecArgs(manager, command);
    const serviceRegistrations = planServiceRegistrations({ cwd, driver, manager, root: dirname(projection?.configPath ?? cwd), workerPort });

    return {
        flavor: "wrangler",
        ipv4LoopbackForced: false,
        remote: { bindings: [], cleanup: () => {}, enabled: false },
        runsCodegenWatch: codegenRequested(options),
        ...(serviceRegistrations.length === 0 ? {} : { serviceRegistrations }),
        studioEnabled: options.studio !== false,
        studioPort,
        workerEnabled: options.worker !== false,
        workerOrigin: `http://localhost:${String(workerPort)}`,
        workerPort,
        wrangler: { args: exec.args, command: exec.command, cwd, tag: command.tool },
    };
};

export { planOwnDevServer, registerServices, resolveTargetFlavor };
