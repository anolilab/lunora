/**
 * The box's process tree (plan 458 D2, D8, W4): one celld node per deployment
 * alias, single-node, each on its own pair of loopback ports, plus Caddy in
 * front of them. Children are {@link SupervisedProcess}es — restarted with
 * backoff, stopped with a budget — and a graceful shutdown drains every fleet
 * before Caddy, so nothing is left proxying to a node that is going away.
 *
 * Every celld flag and variable used here is one `celld --help` (v0.6.0)
 * documents: the internal (peer + unauthenticated operator) listener and the
 * advertised address stay on loopback, the Worker listener is loopback too
 * (only Caddy reaches it), `--trust-forwarded-headers` because Caddy terminates
 * TLS, and bucket durability (`CELLD_DURABILITY`) because a single-node fleet
 * has no follower to ack a write.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DIRECT_LAUNCH, launchCommand, launchIdentity } from "./capabilities";
import type { HostdConfig } from "./config";
import { binaryPaths, fleetBucketUrl } from "./config";
import { edgePaths } from "./edge";
import { ensureFleetDirectory } from "./fleet-directories";
import { CHILD_PATH, fleetEnvironment } from "./fleet-environment";
import type { Isolation } from "./isolation";
import { JobError } from "./job-error";
import type { Logger } from "./log";
import type { SpawnFunction, Timers } from "./process";
import { REAL_TIMERS, SupervisedProcess } from "./process";

/** How long a celld node may take to drain on SIGTERM (its own default bound is 40 s). */
const CELLD_STOP_BUDGET_MS = 45_000;

/** How long Caddy may take to finish in-flight requests on SIGTERM. */
const CADDY_STOP_BUDGET_MS = 10_000;

/** The path every celld node answers readiness on: 200 `{"ok":true}` once ready, 503 while booting or draining. */
const CELLD_HEALTH_PATH = "/.well-known/celld/health";

interface FleetPorts {
    internalPort: number;
    publicPort: number;
}

/**
 * The first pair of free ports in `[first, last]`: two consecutive ports, both
 * unused. Pairs start on even offsets, so allocations never interleave.
 * @throws {JobError} `PORTS_EXHAUSTED` when no pair is left.
 */
const allocatePorts = (range: { first: number; last: number }, used: ReadonlySet<number>): FleetPorts => {
    for (let port = range.first; port + 1 <= range.last; port += 2) {
        if (!used.has(port) && !used.has(port + 1)) {
            return { internalPort: port + 1, publicPort: port };
        }
    }

    throw new JobError("PORTS_EXHAUSTED", `every port pair in ${String(range.first)}-${String(range.last)} is taken; widen ports in the hostd config`);
};

/** How the supervisor starts its children (W8): the fleets as their own user, Caddy without spare capabilities, each fleet in its cgroup. */
type ChildIsolation = Pick<Isolation, "account" | "caddy" | "cgroups" | "fleet">;

/** No isolation: every child runs directly as the daemon's user (tests, development boxes). */
const NO_ISOLATION: ChildIsolation = { caddy: DIRECT_LAUNCH, fleet: DIRECT_LAUNCH };

interface SupervisorOptions {
    config: HostdConfig;
    /** The bucket credentials, re-read at each spawn so a rotated file takes effect on the next restart. */
    credentials: () => Readonly<Record<string, string>>;
    /** Injected for tests. */
    fetch?: typeof fetch;
    logger: Logger;
    /** Each line a child prints on stderr: a fleet's node (with its alias) or Caddy. */
    onStderr?: (child: { alias: string; kind: "celld" } | { kind: "caddy" }, line: string) => void;
    spawn?: SpawnFunction;
    timers?: Timers;
}

/** What the box needs to start a node for `alias`. */
interface FleetLaunch extends FleetPorts {
    alias: string;
}

/** The celld command line of one fleet's node. */
const celldNodeArgs = (config: HostdConfig, launch: FleetLaunch): string[] => [
    "--bucket",
    fleetBucketUrl(config.bucket, launch.alias),
    ...(config.bucket.endpoint === undefined ? [] : ["--endpoint", config.bucket.endpoint]),
    ...(config.bucket.region === undefined ? [] : ["--region", config.bucket.region]),
    "--listen",
    `127.0.0.1:${String(launch.publicPort)}`,
    "--internal-listen",
    `127.0.0.1:${String(launch.internalPort)}`,
    "--advertise",
    `127.0.0.1:${String(launch.internalPort)}`,
    "--trust-forwarded-headers",
];

const pause = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

class Supervisor {
    private caddy: SupervisedProcess | undefined;

    private readonly fleets = new Map<string, { launch: FleetLaunch; process: SupervisedProcess }>();

    private childIsolation: ChildIsolation = NO_ISOLATION;

    private readonly options: SupervisorOptions;

    public constructor(options: SupervisorOptions) {
        this.options = options;
    }

    /** Aliases with a node the supervisor keeps running. */
    public get aliases(): string[] {
        return [...this.fleets.keys()];
    }

    /** Whether `alias` has a node the supervisor keeps running. */
    public isRunning(alias: string): boolean {
        return this.fleets.has(alias);
    }

    /** The last lines `alias`'s node printed, for `diagnose`. */
    public outputOf(alias: string): ReadonlyArray<string> {
        return this.fleets.get(alias)?.process.recentOutput ?? [];
    }

    /** The last lines Caddy printed. */
    public get caddyOutput(): ReadonlyArray<string> {
        return this.caddy?.recentOutput ?? [];
    }

    /** How children are started: {@link NO_ISOLATION} until {@link isolate} is called. */
    public get isolation(): ChildIsolation {
        return this.childIsolation;
    }

    /** Start every child from now on as `isolation` says (the daemon calls this once, before starting any). */
    public isolate(isolation: ChildIsolation): void {
        this.childIsolation = isolation;
    }

    /** Start `alias`'s node on its ports; a no-op while it already runs on them. */
    public startFleet(launch: FleetLaunch): void {
        const existing = this.fleets.get(launch.alias);

        if (existing !== undefined) {
            existing.process.start();

            return;
        }

        const { config, logger } = this.options;
        const { account, cgroups, fleet } = this.isolation;
        const directory = ensureFleetDirectory(config.dataDir, launch.alias, account);
        const command = launchCommand(fleet, binaryPaths(config).celld, celldNodeArgs(config, launch));

        const process = new SupervisedProcess({
            args: command.args,
            command: command.command,
            cwd: directory,
            env: fleetEnvironment({
                credentials: this.options.credentials(),
                directory,
                kind: "node",
                ...(config.bucket.region === undefined ? {} : { region: config.bucket.region }),
            }),
            ...launchIdentity(fleet),
            logger,
            name: `celld ${launch.alias}`,
            onLine: (line, stream) => {
                if (stream === "stderr") {
                    this.options.onStderr?.({ alias: launch.alias, kind: "celld" }, line);
                }
            },
            ...(cgroups === undefined
                ? {}
                : {
                      onSpawn: (pid: number) => {
                          try {
                              cgroups.attach(launch.alias, pid);
                          } catch (error) {
                              logger.warn(`could not put ${launch.alias}'s node into its cgroup: ${(error as Error).message}`);
                          }
                      },
                  }),
            ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
            ...(this.options.timers === undefined ? {} : { timers: this.options.timers }),
        });

        this.fleets.set(launch.alias, { launch, process });
        process.start();
    }

    /** Stop `alias`'s node and forget it. Resolves once it has exited. */
    public async stopFleet(alias: string): Promise<void> {
        const fleet = this.fleets.get(alias);

        if (fleet === undefined) {
            return;
        }

        this.fleets.delete(alias);
        await fleet.process.stop(CELLD_STOP_BUDGET_MS);
        this.isolation.cgroups?.release(alias);
    }

    /** Restart `alias`'s node in place (`reload`): stop it, then start it on the same ports. */
    public async restartFleet(alias: string): Promise<void> {
        const fleet = this.fleets.get(alias);

        if (fleet === undefined) {
            throw new JobError("NO_FLEET", `no fleet runs for ${alias} on this box`);
        }

        await this.stopFleet(alias);
        this.startFleet(fleet.launch);
    }

    /**
     * Resolve once `alias`'s node answers its health route with 200, polling
     * every 250 ms.
     * @throws {JobError} `HEALTH_TIMEOUT` past `deadlineMs`, with the node's last output.
     */
    public async waitHealthy(alias: string, deadlineMs: number): Promise<void> {
        const fleet = this.fleets.get(alias);

        if (fleet === undefined) {
            throw new JobError("NO_FLEET", `no fleet runs for ${alias} on this box`);
        }

        const fetcher = this.options.fetch ?? globalThis.fetch;
        const url = `http://127.0.0.1:${String(fleet.launch.publicPort)}${CELLD_HEALTH_PATH}`;
        const timers = this.options.timers ?? REAL_TIMERS;
        const deadline = timers.now() + deadlineMs;

        while (timers.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop -- readiness is polled sequentially
            const status = await fetcher(url, { signal: AbortSignal.timeout(2000) }).then(
                async (response) => {
                    await response.body?.cancel();

                    return response.status;
                },
                () => 0,
            );

            if (status === 200) {
                return;
            }

            // eslint-disable-next-line no-await-in-loop -- readiness is polled sequentially
            await pause(250);
        }

        const tail = fleet.process.recentOutput.slice(-10).join("\n");

        throw new JobError(
            "HEALTH_TIMEOUT",
            `${alias}'s node did not report healthy within ${String(deadlineMs)} ms${tail === "" ? "" : `; it printed:\n${tail}`}`,
        );
    }

    /** Start Caddy on `configPath` (its JSON config, admin API included). */
    public startCaddy(configPath: string): void {
        const { config } = this.options;
        const { log, state } = edgePaths(config.dataDir);

        // Laid out for the edge user by the isolation setup; created here as the daemon's own otherwise.
        mkdirSync(state, { mode: 0o700, recursive: true });
        mkdirSync(log, { mode: 0o750, recursive: true });

        const command = launchCommand(this.isolation.caddy, binaryPaths(config).caddy, ["run", "--config", configPath]);

        this.caddy ??= new SupervisedProcess({
            args: command.args,
            command: command.command,
            cwd: state,
            // Certificates and Caddy's own state stay in its own directory.
            env: { HOME: state, PATH: CHILD_PATH, XDG_CONFIG_HOME: join(state, "config"), XDG_DATA_HOME: join(state, "data") },
            ...launchIdentity(this.isolation.caddy),
            logger: this.options.logger,
            name: "caddy",
            onLine: (line, stream) => {
                if (stream === "stderr") {
                    this.options.onStderr?.({ kind: "caddy" }, line);
                }
            },
            ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
            ...(this.options.timers === undefined ? {} : { timers: this.options.timers }),
        });
        this.caddy.start();
    }

    /** Restart every child (after an `upgrade` swapped their binaries): fleets one at a time, then Caddy. */
    public async restartAll(onProgress: (line: string) => void): Promise<void> {
        for (const alias of this.aliases) {
            onProgress(`restarting ${alias}`);
            // eslint-disable-next-line no-await-in-loop -- one fleet at a time keeps the others serving
            await this.restartFleet(alias);
            // eslint-disable-next-line no-await-in-loop -- one fleet at a time keeps the others serving
            await this.waitHealthy(alias, 120_000);
        }

        if (this.caddy !== undefined) {
            onProgress("restarting caddy");
            await this.caddy.stop(CADDY_STOP_BUDGET_MS);
            this.caddy.start();
        }
    }

    /** Graceful shutdown: drain every fleet (in parallel), then stop Caddy. */
    public async shutdown(): Promise<void> {
        await Promise.all(this.aliases.map(async (alias) => this.stopFleet(alias)));
        await this.caddy?.stop(CADDY_STOP_BUDGET_MS);
    }
}

export type { ChildIsolation, FleetLaunch, FleetPorts, SupervisorOptions };
export { allocatePorts, CADDY_STOP_BUDGET_MS, CELLD_HEALTH_PATH, CELLD_STOP_BUDGET_MS, celldNodeArgs, NO_ISOLATION, Supervisor };
