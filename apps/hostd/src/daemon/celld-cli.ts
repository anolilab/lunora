/**
 * One-shot celld commands a job runs: `celld deploy` (write a release to a
 * fleet's bucket prefix) and `celld diagnose --json`. Their output streams
 * line by line to the job's progress, and a command that hangs is killed.
 * In the daemon they run like the fleet's node (W8): as the fleet user, in its
 * working directory, with the fleet's allowlisted environment.
 */
import { tmpdir } from "node:os";

import type { ChildLaunch } from "./capabilities";
import { DIRECT_LAUNCH } from "./capabilities";
import type { ChildResult } from "./child";
import { runChild } from "./child";
import type { HostdConfig } from "./config";
import { binaryPaths, fleetBucketUrl } from "./config";
import { fleetEnvironment } from "./fleet-environment";
import { JobError } from "./job-error";

/** How long `celld deploy` may take: it uploads the bundle and assets to the bucket. */
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long `celld diagnose` may take: it probes the bucket and every live node. */
const DIAGNOSE_TIMEOUT_MS = 60_000;

/** Where and how a one-shot celld runs: the fleet's directory and launch in the daemon, the caller's own elsewhere (enrol). */
interface CelldPlacement {
    /** The working directory, `HOME` and `TMPDIR`; the system's temporary directory when absent. */
    directory?: string;
    launch?: ChildLaunch;
}

interface CelldRun {
    /** The exit code; `undefined` when celld was killed by a signal. */
    code: number | undefined;
    lines: string[];
}

/** The bucket flags every celld command against `alias`'s fleet takes. */
const bucketArgs = (config: HostdConfig, alias: string): string[] => [
    "--bucket",
    fleetBucketUrl(config.bucket, alias),
    ...(config.bucket.endpoint === undefined ? [] : ["--endpoint", config.bucket.endpoint]),
    ...(config.bucket.region === undefined ? [] : ["--region", config.bucket.region]),
];

/**
 * Run celld with `args`, handing each output line (stdout and stderr, as they
 * arrive) to `onLine`. Never rejects for a non-zero exit — the caller decides
 * what that means.
 * @throws {JobError} `CELLD_FAILED` when celld cannot be started or outlives `timeoutMs`.
 */
const runCelld = async (
    config: HostdConfig,
    args: ReadonlyArray<string>,
    options: CelldPlacement & { credentials: Readonly<Record<string, string>>; onLine?: (line: string) => void; timeoutMs: number },
): Promise<CelldRun> => {
    const directory = options.directory ?? tmpdir();
    const { celld } = binaryPaths(config);
    const lines: string[] = [];
    let result: ChildResult;

    try {
        result = await runChild(options.launch ?? DIRECT_LAUNCH, celld, args, {
            cwd: directory,
            env: fleetEnvironment({
                credentials: options.credentials,
                directory,
                kind: "command",
                ...(config.bucket.region === undefined ? {} : { region: config.bucket.region }),
            }),
            onLine: (line) => {
                lines.push(line);
                options.onLine?.(line);
            },
            timeoutMs: options.timeoutMs,
        });
    } catch (error) {
        throw new JobError("CELLD_FAILED", (error as Error).message);
    }

    if (result.timedOut) {
        throw new JobError("CELLD_FAILED", `celld ${args[0] ?? ""} did not finish within ${String(options.timeoutMs)} ms`);
    }

    return { code: result.code ?? undefined, lines };
};

/**
 * `celld deploy {directory} --bucket s3://{bucket}/fleets/{alias} …`: write the
 * release to the fleet's prefix. A running node adopts it at its next pointer poll.
 * @returns the version celld wrote
 * @throws {JobError} `CELLD_FAILED` when celld refuses the release.
 */
const celldDeploy = async (
    config: HostdConfig,
    alias: string,
    directory: string,
    options: CelldPlacement & { credentials: Readonly<Record<string, string>>; onLine: (line: string) => void },
): Promise<string | undefined> => {
    const run = await runCelld(config, ["deploy", directory, ...bucketArgs(config, alias), "--json"], {
        ...options,
        timeoutMs: DEPLOY_TIMEOUT_MS,
    });

    if (run.code !== 0) {
        throw new JobError("CELLD_FAILED", `celld deploy exited ${String(run.code)}: ${run.lines.slice(-5).join(" | ")}`);
    }

    // `--json` prints the deployment as its last line: {"version": …}.
    for (const line of run.lines.toReversed()) {
        try {
            const parsed = JSON.parse(line) as { version?: unknown };

            return typeof parsed.version === "string" ? parsed.version : undefined;
        } catch {
            // Not the JSON line.
        }
    }

    return undefined;
};

/** `celld diagnose --json` for `alias`'s fleet: one JSON object per line, per check. */
const celldDiagnose = async (
    config: HostdConfig,
    alias: string,
    credentials: Readonly<Record<string, string>>,
    placement: CelldPlacement = {},
): Promise<CelldRun> => runCelld(config, ["diagnose", "--json", ...bucketArgs(config, alias)], { ...placement, credentials, timeoutMs: DIAGNOSE_TIMEOUT_MS });

export type { CelldPlacement, CelldRun };
export { bucketArgs, celldDeploy, celldDiagnose, runCelld };
