/**
 * `lunora dev` for a target whose toolchain runs its own dev server
 * (`devServer: "own"` — celld): the standalone flavor, with the host's dev
 * server on the projected wrangler config as the worker.
 */
import type { DeployDriver } from "@lunora/config";
import { planToolchainInvocation, startCelldDevSession, targetRunsOwnDevServer } from "@lunora/config";

import { detectPackageManager, toolchainExecArgs } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { DevFlavor } from "./lifecycle";
import { codegenRequested } from "./lifecycle";
import type { DevCommandOptions, DevCommandPlan, WorkerProcess } from "./types";

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
 * The worker for `lunora dev --target celld`: a celld dev session
 * (`@lunora/config`), the same one `@lunora/vite` and `@lunora/rspack/rsbuild`
 * run. It registers each `lunora.config` service (plan 457) in the local state
 * before the app, and re-registers a service and restarts the app when a file
 * under its folder changes. Wrapped as a {@link WorkerProcess} so the dev
 * supervisor stops it like any other worker.
 */
const startCelldWorker = async (inputs: { logger: Logger; port: number; projectRoot: string; start?: typeof startCelldDevSession }): Promise<WorkerProcess> => {
    const { logger } = inputs;
    const session = await (inputs.start ?? startCelldDevSession)({
        log: (line, source) => {
            logger.info(source === "app" ? `[celld] ${line}` : `[celld:${source}] ${line}`);
        },
        port: inputs.port,
        projectRoot: inputs.projectRoot,
    });
    let settle: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
        settle = resolve;
    });

    return {
        // A crash of the app's `celld dev` ends `lunora dev`, as any worker exit does.
        exited: Promise.race([exited, session.exited]),
        kill: () => {
            session
                .stop()
                .then(
                    () => 0,
                    () => 1,
                )
                .then(settle)
                .catch(() => undefined);
        },
    };
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

    const exec = toolchainExecArgs(detectPackageManager(cwd), command);

    return {
        flavor: "wrangler",
        ipv4LoopbackForced: false,
        remote: { bindings: [], cleanup: () => {}, enabled: false },
        runsCodegenWatch: codegenRequested(options),
        // celld runs as a dev session (services registered first, restarted on edit), not a bare `celld dev`.
        ...(driver.id === "celld" ? { celldSession: true } : {}),
        studioEnabled: options.studio !== false,
        studioPort,
        workerEnabled: options.worker !== false,
        workerOrigin: `http://localhost:${String(workerPort)}`,
        workerPort,
        wrangler: { args: exec.args, command: exec.command, cwd, tag: command.tool },
    };
};

export { planOwnDevServer, resolveTargetFlavor, startCelldWorker };
