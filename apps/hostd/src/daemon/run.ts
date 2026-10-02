/**
 * `lunora-hostd run` — the daemon (plan 458 W4): one process, started by
 * systemd, that holds the control session, supervises the fleets and Caddy,
 * runs jobs, keeps the edge in step with the routing table and reports request
 * counts. Also `lunora-hostd status`, which reads the same files offline.
 */
import { existsSync, statfsSync } from "node:fs";
import { freemem } from "node:os";

import type { TrustedReleaseKey } from "../release";
import { HOSTD_TRUSTED_RELEASE_KEYS } from "../release";
import { HOSTD_PROTOCOL_LIMITS, HOSTD_PROTOCOL_VERSION } from "../wire/constants";
import type { HelloMessage, RouteEntry } from "../wire/types";
import { CaddyController } from "./caddy";
import type { HostdConfig } from "./config";
import { binaryPaths, ConfigError, loadBucketCredentials } from "./config";
import { loadIdentity } from "./identity";
import type { Isolation, IsolationSystem } from "./isolation";
import { helloIsolation, setUpIsolation } from "./isolation";
import { JobRunner } from "./jobs";
import type { Logger } from "./log";
import LogTailer from "./log-tailer";
import type { SpawnFunction } from "./process";
import { ReportQueue } from "./report-queue";
import { ReportAggregator } from "./reports";
import type { SocketFactory } from "./session";
import { Session } from "./session";
import { createSignedFetch } from "./signed-fetch";
import type { HostdState } from "./state";
import { fleetSummaries, loadState, saveState } from "./state";
import { Supervisor } from "./supervisor";
import { installedVersions, runUpgrade } from "./upgrade";

/** How often the access log is read and closed report windows are sent. */
const REPORT_TICK_MS = 10_000;

/** How long a replaced `lunora-hostd` waits for its job's result to leave before it exits. */
const SELF_REPLACE_GRACE_MS = 3000;

const MIB = 1024 * 1024;

/** Exit codes: 0 stopped (or restarting into an upgrade), 2 revoked, 1 anything else. */
const EXIT_REVOKED = 2;

interface DaemonOptions {
    config: HostdConfig;
    /** Injected for tests. */
    fetch?: typeof fetch;
    /** What the isolation self-check reads and runs: the real system unless a test injects its own. */
    isolation?: IsolationSystem;
    logger: Logger;
    /** Report tick, injected for tests. */
    reportTickMs?: number;
    socket?: SocketFactory;
    spawn?: SpawnFunction;
    /** The release keys an `upgrade` trusts: the compiled-in set unless a test injects its own. */
    trustedKeys?: Readonly<Record<string, TrustedReleaseKey>>;
}

/** The daemon's process tree and session, wired together. */
class Daemon {
    public readonly caddy: CaddyController;

    public readonly state: HostdState;

    public readonly supervisor: Supervisor;

    private isolation: Isolation | undefined;

    private routes: RouteEntry[] = [];

    private selfReplaced = false;

    private reportTimer: ReturnType<typeof setInterval> | undefined;

    private session: Session | undefined;

    private versions = { caddy: "unknown", celld: "unknown", hostd: "unknown" };

    private readonly options: DaemonOptions;

    private readonly reports = new ReportAggregator();

    private readonly reportQueue = new ReportQueue();

    public constructor(options: DaemonOptions) {
        this.options = options;
        this.state = loadState(options.config.dataDir);

        this.supervisor = new Supervisor({
            config: options.config,
            credentials: () => this.credentials(),
            logger: options.logger,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        });
        this.caddy = new CaddyController({
            caddy: options.config.caddy,
            dataDir: options.config.dataDir,
            hostname: options.config.hostname,
            logger: options.logger,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
    }

    /** The current routing table, as the control plane last pushed it. */
    public get routeTable(): ReadonlyArray<RouteEntry> {
        return this.routes;
    }

    /**
     * Start everything and hold the session until it ends.
     * @returns the process exit code
     */
    public async run(): Promise<number> {
        const { config, logger } = this.options;

        if (process.getuid?.() === 0 && !config.allowRoot) {
            throw new ConfigError("lunora-hostd refuses to run as root: run it as its own user (the systemd unit does), or set allowRoot in the config");
        }

        const identity = loadIdentity(config.keyFile);
        const signedFetch = createSignedFetch({
            boxId: config.boxId,
            controlPlane: config.controlPlane,
            identity,
            ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        });

        const isolation = await setUpIsolation(config, logger, this.options.isolation);

        this.isolation = isolation;
        this.supervisor.isolate(isolation);
        this.versions = await installedVersions(config);
        await this.startEdge();
        this.restoreFleets();

        let session: Session | undefined;
        const runner = new JobRunner(
            {
                applyEdge: async () => this.applyEdge(),
                caddy: this.caddy,
                config,
                credentials: () => this.credentials(),
                dropRoutes: (alias) => {
                    this.routes = this.routes.filter((route) => route.alias !== alias);
                },
                ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
                isolation: isolation.report,
                logger,
                saveState: () => {
                    saveState(config.dataDir, this.state);
                },
                signedFetch,
                state: this.state,
                supervisor: this.supervisor,
                upgrade: async (job, progress) => {
                    await runUpgrade(
                        job,
                        {
                            config,
                            ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
                            onSelfReplaced: () => {
                                this.selfReplaced = true;
                            },
                            signedFetch,
                            supervisor: this.supervisor,
                            trustedKeys: this.options.trustedKeys ?? HOSTD_TRUSTED_RELEASE_KEYS,
                        },
                        progress,
                    );
                    this.versions = await installedVersions(config);

                    if (this.selfReplaced) {
                        // The job's result goes first; then systemd starts the new binary.
                        setTimeout(() => {
                            session?.stop();
                        }, SELF_REPLACE_GRACE_MS);
                    }
                },
            },
            (message) => session?.send(message) ?? false,
        );

        session = new Session({
            boxId: config.boxId,
            controlPlane: config.controlPlane,
            hello: () => this.hello(),
            identity,
            logger,
            onJob: (message) => {
                runner.submit(message);
            },
            onReady: () => {
                this.reportQueue.drain((report) => session?.send(report) ?? false, Date.now());
            },
            onRoutes: (table) => {
                this.onRoutes(table, (alias) => runner.busy(alias)).catch((error: unknown) => {
                    logger.warn(`could not apply the routing table: ${(error as Error).message}`);
                });
            },
            ...(this.options.socket === undefined ? {} : { socket: this.options.socket }),
        });
        this.session = session;
        this.startReports(session);

        const end = await session.run();

        await this.shutdown();

        if (end.code === "BOX_REVOKED") {
            logger.error("stopping: this box is no longer enrolled. Enrol the machine again (lunora-hostd enrol --force) to use it");

            return EXIT_REVOKED;
        }

        return 0;
    }

    /** Stop the session; {@link run} then drains the fleets and Caddy and resolves. */
    public stop(): void {
        this.session?.stop();
    }

    private hello(): HelloMessage {
        let diskFreeMb = 0;

        try {
            const stats = statfsSync(this.options.config.dataDir);

            diskFreeMb = Math.floor((stats.bavail * stats.bsize) / MIB);
        } catch {
            // Reported as 0: the data directory is missing, which diagnose shows.
        }

        return {
            boxId: this.options.config.boxId,
            fleets: fleetSummaries(this.state, HOSTD_PROTOCOL_LIMITS.maxFleets),
            ...(this.isolation === undefined ? {} : { isolation: helloIsolation(this.isolation.report) }),
            protocol: HOSTD_PROTOCOL_VERSION,
            resources: { diskFreeMb, memMb: Math.floor(freemem() / MIB) },
            type: "hello",
            versions: this.versions,
        };
    }

    /** Write Caddy's boot config, start it when installed, and serve the `ask` endpoint. */
    private async startEdge(): Promise<void> {
        const { config, logger } = this.options;

        this.caddy.writeBootConfig(this.routes, this.ports());

        const { caddy } = binaryPaths(config);

        if (existsSync(caddy)) {
            this.supervisor.startCaddy(this.caddy.configPath);
        } else {
            logger.warn(`no Caddy at ${caddy}: fleets run, but nothing serves them publicly`);
        }

        await this.caddy.listenAsk();
    }

    /** Start the fleets the box ran before it stopped; the routing table then says which stay up. */
    private restoreFleets(): void {
        if (this.isolation?.report.startsFleets === false) {
            return;
        }

        for (const [alias, record] of Object.entries(this.state.fleets)) {
            if (record.state !== "stopped") {
                this.supervisor.startFleet({ alias, internalPort: record.internalPort, publicPort: record.publicPort });
            }
        }
    }

    /** Each running fleet's Worker port. */
    private ports(): Map<string, number> {
        return new Map(
            this.supervisor.aliases.flatMap((alias) => (this.state.fleets[alias] === undefined ? [] : [[alias, this.state.fleets[alias].publicPort] as const])),
        );
    }

    private async applyEdge(): Promise<void> {
        await this.caddy.apply(this.routes, this.ports());
    }

    /**
     * A new routing table: the control plane is the source of truth, so a fleet
     * it no longer routes is stopped (never deleted — a `destroy` deletes) and
     * one it routes again is started.
     */
    private async onRoutes(table: RouteEntry[], busy: (alias: string) => boolean): Promise<void> {
        this.routes = table;
        this.reports.setRoutes(table);

        const routed = new Set(table.map((route) => route.alias));

        for (const [alias, record] of Object.entries(this.state.fleets)) {
            if (busy(alias)) {
                continue;
            }

            if (!routed.has(alias) && record.state !== "stopped") {
                this.options.logger.info(`stopping fleet ${alias}: the control plane no longer routes it`);
                // eslint-disable-next-line no-await-in-loop -- one fleet at a time
                await this.supervisor.stopFleet(alias);
                this.state.fleets[alias] = { ...record, state: "stopped", updatedAt: Date.now() };
            } else if (routed.has(alias) && record.state === "stopped" && this.isolation?.report.startsFleets !== false) {
                this.supervisor.startFleet({ alias, internalPort: record.internalPort, publicPort: record.publicPort });
                this.state.fleets[alias] = { ...record, state: "running", updatedAt: Date.now() };
            }
        }

        saveState(this.options.config.dataDir, this.state);
        await this.applyEdge();
    }

    private startReports(session: Session): void {
        const tailer = new LogTailer(this.caddy.accessLogPath);

        this.reportTimer = setInterval(() => {
            for (const line of tailer.read()) {
                this.reports.ingest(line);
            }

            const now = Date.now();

            this.reportQueue.push(this.reports.close(now));
            this.reportQueue.drain((report) => session.send(report), now);
        }, this.options.reportTickMs ?? REPORT_TICK_MS);
    }

    /** The bucket credentials, read from their file at each use so a rotated file takes effect on the next spawn. */
    private credentials(): Readonly<Record<string, string>> {
        return loadBucketCredentials(this.options.config.credentialsFile);
    }

    private async shutdown(): Promise<void> {
        if (this.reportTimer !== undefined) {
            clearInterval(this.reportTimer);
        }

        saveState(this.options.config.dataDir, this.state);
        await this.supervisor.shutdown();
        await this.caddy.close();
        this.isolation?.stop();
    }
}

/** `lunora-hostd status`: the enrolment and the fleets, from the files on disk. Never prints a secret. */
const statusText = (config: HostdConfig): string => {
    const state = loadState(config.dataDir);
    const lines = [
        `box:           ${config.boxId} (${config.hostname})`,
        `control plane: ${config.controlPlane}`,
        `bucket:        s3://${config.bucket.name}${config.bucket.endpoint === undefined ? "" : ` via ${config.bucket.endpoint}`}`,
        `data:          ${config.dataDir}`,
        `single-trust:  ${config.singleTrust ? "yes" : "no"}`,
        `fleet user:    ${config.fleetUser}`,
        `install:       ${config.installDir}`,
        `fleets:        ${String(Object.keys(state.fleets).length)}`,
        ...Object.entries(state.fleets)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([alias, record]) => `  ${alias}: ${record.state}, deployment ${record.deploymentId ?? "none"}, 127.0.0.1:${String(record.publicPort)}`),
    ];

    return `${lines.join("\n")}\n`;
};

export type { DaemonOptions };
export { Daemon, EXIT_REVOKED, statusText };
