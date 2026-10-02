/**
 * Running the jobs the control plane hands the box (plan 458 W4 "Jobs",
 * protocol §5.2): `deploy`, `destroy`, `reload`, `diagnose` and `upgrade`.
 *
 * Each job streams `progress` lines (each capped at the protocol's 8 KiB) and
 * ends with exactly one `result`. Jobs for one alias never overlap — a second
 * one is refused with `ALIAS_BUSY` — at most {@link MAX_CONCURRENT_JOBS} run at
 * once, and an `upgrade`, which restarts every child, runs alone.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import HOSTD_VERSION from "../version";
import { HOSTD_PROTOCOL_LIMITS } from "../wire/constants";
import type { BoxMessage, DeployJob, DestroyJob, HostdJob, JobMessage, ReloadJob, UpgradeJob } from "../wire/types";
import { deletePrefix } from "./bucket";
import type { CaddyController } from "./caddy";
import { celldDeploy, celldDiagnose } from "./celld-cli";
import type { HostdConfig } from "./config";
import { fleetPrefix } from "./config";
import { JobError, jobFailure, truncateUtf8 } from "./job-error";
import type { Logger } from "./log";
import { fetchRelease, writeReleaseDirectory } from "./release-files";
import type { SignedFetch } from "./signed-fetch";
import type { FleetRecord, HostdState } from "./state";
import type { Supervisor } from "./supervisor";
import { allocatePorts } from "./supervisor";

/** Jobs running at once across the box. */
const MAX_CONCURRENT_JOBS = 2;

/** Progress lines one job may send; the rest are summarised in one line. */
const MAX_PROGRESS_LINES = 400;

/** How long a fleet may take to report healthy after a deploy or reload. */
const HEALTH_DEADLINE_MS = 120_000;

/** What the jobs act on; built once by the daemon. */
interface JobContext {
    /** Re-apply Caddy's config for the current routes and running fleets. */
    applyEdge: () => Promise<void>;
    caddy?: CaddyController;
    config: HostdConfig;
    credentials: () => Readonly<Record<string, string>>;
    /** Drop `alias`'s hostnames from the local routing table until the control plane pushes a new one. */
    dropRoutes: (alias: string) => void;
    /** Injected for tests. */
    fetch?: typeof fetch;
    logger: Logger;
    /** Persist `state` after a change. */
    saveState: () => void;
    signedFetch: SignedFetch;
    state: HostdState;
    supervisor: Supervisor;
    /** Run an `upgrade` job. */
    upgrade: (job: UpgradeJob, progress: (line: string) => void) => Promise<void>;
}

type Progress = (line: string) => void;

/** The public URL a deploy answers on: `{alias}.{box hostname}`, on Caddy's port. */
const publicUrlOf = (config: HostdConfig, alias: string): string => {
    const { httpPort, httpsPort, tls } = config.caddy;
    const port = tls ? httpsPort : httpPort;
    const isDefault = port === (tls ? 443 : 80);

    return `${tls ? "https" : "http"}://${alias}.${config.hostname}${isDefault ? "" : `:${String(port)}`}`;
};

const setFleet = (context: JobContext, alias: string, record: FleetRecord): void => {
    context.state.fleets[alias] = record;
    context.saveState();
};

/** The ports every fleet on the box holds. */
const usedPorts = (state: HostdState): Set<number> => new Set(Object.values(state.fleets).flatMap((record) => [record.publicPort, record.internalPort]));

const deploy = async (context: JobContext, job: DeployJob, progress: Progress): Promise<string> => {
    const { config } = context;

    progress(`fetching release ${job.deploymentId}`);

    const { bytes, release } = await fetchRelease(context.signedFetch, job.releaseUrl);

    progress(
        `release ${job.deploymentId}: ${String(bytes)} bytes, ${String(release.manifest.bindings.length)} bindings, ${String(release.assets?.files.length ?? 0)} assets`,
    );

    const directory = join(config.dataDir, "releases", job.deploymentId);

    writeReleaseDirectory(directory, release, job);
    progress(`wrote ${directory}`);

    const version = await celldDeploy(config, job.alias, directory, {
        credentials: context.credentials(),
        onLine: (line) => {
            progress(`celld: ${line}`);
        },
    });

    progress(`celld wrote version ${version ?? "(unknown)"} to fleets/${job.alias}/; a running node adopts it at its next pointer poll`);

    const previous = context.state.fleets[job.alias];
    const ports = previous ?? allocatePorts(config.ports, usedPorts(context.state));
    const launch = { alias: job.alias, internalPort: ports.internalPort, publicPort: ports.publicPort };

    setFleet(context, job.alias, { deploymentId: job.deploymentId, ...ports, state: "starting", updatedAt: Date.now() });
    progress(
        context.supervisor.isRunning(job.alias) ? `fleet ${job.alias} is running` : `starting fleet ${job.alias} on 127.0.0.1:${String(launch.publicPort)}`,
    );
    context.supervisor.startFleet(launch);

    try {
        await context.supervisor.waitHealthy(job.alias, HEALTH_DEADLINE_MS);
    } catch (error) {
        setFleet(context, job.alias, { deploymentId: job.deploymentId, ...ports, state: "failed", updatedAt: Date.now() });
        throw error;
    }

    setFleet(context, job.alias, { deploymentId: job.deploymentId, ...ports, state: "running", updatedAt: Date.now() });
    progress(`fleet ${job.alias} is healthy`);
    await context.applyEdge();

    // The previous release's files are no longer needed: the bucket holds every version celld keeps.
    if (previous?.deploymentId !== undefined && previous.deploymentId !== job.deploymentId) {
        rmSync(join(config.dataDir, "releases", previous.deploymentId), { force: true, recursive: true });
    }

    return publicUrlOf(config, job.alias);
};

const destroy = async (context: JobContext, job: DestroyJob, progress: Progress): Promise<void> => {
    const { config } = context;
    const record = context.state.fleets[job.alias];

    progress(`stopping fleet ${job.alias}`);
    await context.supervisor.stopFleet(job.alias);
    context.dropRoutes(job.alias);
    await context.applyEdge();

    if (record !== undefined) {
        Reflect.deleteProperty(context.state.fleets, job.alias);
        context.saveState();
    }

    rmSync(join(config.dataDir, "fleets", job.alias), { force: true, recursive: true });

    if (record?.deploymentId !== undefined) {
        rmSync(join(config.dataDir, "releases", record.deploymentId), { force: true, recursive: true });
    }

    if (job.deleteData) {
        progress(`deleting s3://${config.bucket.name}/${fleetPrefix(job.alias)}/`);

        const deleted = await deletePrefix(`${fleetPrefix(job.alias)}/`, {
            bucket: config.bucket,
            credentials: context.credentials(),
            ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
        });

        progress(`deleted ${String(deleted)} objects`);
    } else {
        progress(`kept s3://${config.bucket.name}/${fleetPrefix(job.alias)}/`);
    }
};

const reload = async (context: JobContext, job: ReloadJob, progress: Progress): Promise<void> => {
    const record = context.state.fleets[job.alias];

    if (record === undefined) {
        throw new JobError("NO_FLEET", `no fleet for ${job.alias} on this box`);
    }

    progress(`restarting fleet ${job.alias}`);

    if (context.supervisor.isRunning(job.alias)) {
        await context.supervisor.restartFleet(job.alias);
    } else {
        context.supervisor.startFleet({ alias: job.alias, internalPort: record.internalPort, publicPort: record.publicPort });
    }

    await context.supervisor.waitHealthy(job.alias, HEALTH_DEADLINE_MS);
    setFleet(context, job.alias, { ...record, state: "running", updatedAt: Date.now() });
    await context.applyEdge();
    progress(`fleet ${job.alias} is healthy`);
};

const diagnose = async (context: JobContext, progress: Progress): Promise<void> => {
    const { config } = context;

    progress(`lunora-hostd ${HOSTD_VERSION}, box ${config.boxId} (${config.hostname})`);
    progress(context.caddy?.lastError === undefined ? "caddy: config loaded" : `caddy: ${context.caddy.lastError}`);

    for (const line of context.supervisor.caddyOutput.slice(-5)) {
        progress(`caddy| ${line}`);
    }

    const aliases = Object.keys(context.state.fleets).toSorted((a, b) => a.localeCompare(b));

    if (aliases.length === 0) {
        progress("no fleets on this box");
    }

    for (const alias of aliases) {
        const record = context.state.fleets[alias] as FleetRecord;

        progress(
            `fleet ${alias}: ${record.state}, deployment ${record.deploymentId ?? "none"}, 127.0.0.1:${String(record.publicPort)} (internal ${String(record.internalPort)})`,
        );

        // eslint-disable-next-line no-await-in-loop -- one fleet's probe at a time keeps the output in order
        const run = await celldDiagnose(config, alias, context.credentials()).catch((error: unknown) => {
            return { code: undefined, lines: [`celld diagnose failed: ${(error as Error).message}`] };
        });

        for (const line of run.lines) {
            progress(`${alias}| ${line}`);
        }

        for (const line of context.supervisor.outputOf(alias).slice(-5)) {
            progress(`${alias} log| ${line}`);
        }
    }
};

/** The alias a job locks, `*` for one that needs the whole box, `undefined` for one that needs nothing. */
const lockOf = (job: HostdJob): string | undefined => {
    switch (job.kind) {
        case "diagnose": {
            return undefined;
        }
        case "upgrade": {
            return "*";
        }
        default: {
            return job.alias;
        }
    }
};

/** Runs jobs, at most {@link MAX_CONCURRENT_JOBS} at once, one per alias, an `upgrade` alone. */
class JobRunner {
    private readonly queue: JobMessage[] = [];

    private readonly running = new Map<string, string | undefined>();

    private readonly settled = new Set<() => void>();

    private readonly context: JobContext;

    private readonly send: (message: BoxMessage) => boolean;

    public constructor(context: JobContext, send: (message: BoxMessage) => boolean) {
        this.context = context;
        this.send = send;
    }

    /** Whether a job for `alias` is queued or running. */
    public busy(alias: string): boolean {
        return [...this.running.values()].includes(alias) || this.queue.some((message) => lockOf(message.job) === alias);
    }

    /** Accept a job from the control plane. */
    public submit(message: JobMessage): void {
        const lock = lockOf(message.job);

        if (lock !== undefined && lock !== "*" && this.busy(lock)) {
            this.finish(message.jobId, { code: "ALIAS_BUSY", message: `a job for ${lock} is already running on this box` });

            return;
        }

        this.queue.push(message);
        this.pump();
    }

    /** Resolves once no job is queued or running (for tests and shutdown). */
    public async idle(): Promise<void> {
        if (this.running.size === 0 && this.queue.length === 0) {
            return;
        }

        await new Promise<void>((resolve) => {
            this.settled.add(resolve);
        });
    }

    private runnable(message: JobMessage): boolean {
        const lock = lockOf(message.job);
        const locks = new Set(this.running.values());

        if (locks.has("*")) {
            return false;
        }

        if (lock === "*") {
            return this.running.size === 0;
        }

        return lock === undefined || !locks.has(lock);
    }

    private pump(): void {
        while (this.running.size < MAX_CONCURRENT_JOBS) {
            const index = this.queue.findIndex((message) => this.runnable(message));

            if (index === -1) {
                break;
            }

            const [message] = this.queue.splice(index, 1) as [JobMessage];

            this.running.set(message.jobId, lockOf(message.job));
            const settle = (): void => {
                this.running.delete(message.jobId);
                this.pump();

                if (this.running.size === 0 && this.queue.length === 0) {
                    for (const resolve of this.settled) {
                        resolve();
                    }

                    this.settled.clear();
                }
            };

            // `run` never rejects: a failed job is a failed `result`, not an exception.
            this.run(message)
                .finally(settle)
                .catch(() => undefined);
        }
    }

    private finish(jobId: string, error?: { code: string; message: string }, url?: string): void {
        this.send(
            error === undefined ? { jobId, ok: true, type: "result", ...(url === undefined ? {} : { url }) } : { error, jobId, ok: false, type: "result" },
        );
    }

    private async run(message: JobMessage): Promise<void> {
        const { job, jobId } = message;
        let lines = 0;
        const progress: Progress = (line) => {
            lines += 1;

            if (lines < MAX_PROGRESS_LINES) {
                this.send({ jobId, line: truncateUtf8(line, HOSTD_PROTOCOL_LIMITS.maxLineBytes), type: "progress" });
            } else if (lines === MAX_PROGRESS_LINES) {
                this.send({ jobId, line: "(further progress lines dropped)", type: "progress" });
            }
        };

        this.context.logger.info(`job ${jobId}: ${job.kind}${"alias" in job ? ` ${job.alias}` : ""}`);

        try {
            let url: string | undefined;

            switch (job.kind) {
                case "deploy": {
                    url = await deploy(this.context, job, progress);
                    break;
                }
                case "destroy": {
                    await destroy(this.context, job, progress);
                    break;
                }
                case "diagnose": {
                    await diagnose(this.context, progress);
                    break;
                }
                case "reload": {
                    await reload(this.context, job, progress);
                    break;
                }
                default: {
                    await this.context.upgrade(job, progress);
                }
            }

            this.context.logger.info(`job ${jobId}: done`);
            this.finish(jobId, undefined, url);
        } catch (error) {
            const failure = jobFailure(error);

            this.context.logger.warn(`job ${jobId}: ${failure.code}: ${failure.message}`);
            this.finish(jobId, failure);
        }
    }
}

export type { JobContext };
export { HEALTH_DEADLINE_MS, JobRunner, MAX_CONCURRENT_JOBS, MAX_PROGRESS_LINES, publicUrlOf };
