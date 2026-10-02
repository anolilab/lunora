/**
 * One-shot celld commands a job runs: `celld deploy` (write a release to a
 * fleet's bucket prefix) and `celld diagnose --json`. Their output streams
 * line by line to the job's progress, and a command that hangs is killed.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { HostdConfig } from "./config";
import { fleetBucketUrl } from "./config";
import { JobError } from "./job-error";
import { CHILD_PATH } from "./supervisor";

/** How long `celld deploy` may take: it uploads the bundle and assets to the bucket. */
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long `celld diagnose` may take: it probes the bucket and every live node. */
const DIAGNOSE_TIMEOUT_MS = 60_000;

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
 * Run celld with `args`, handing each output line to `onLine` as it arrives.
 * Never rejects for a non-zero exit — the caller decides what that means.
 * @throws {JobError} `CELLD_FAILED` when celld cannot be started or outlives `timeoutMs`.
 */
const runCelld = async (
    config: HostdConfig,
    args: ReadonlyArray<string>,
    options: { credentials: Readonly<Record<string, string>>; cwd?: string; onLine?: (line: string) => void; timeoutMs: number },
): Promise<CelldRun> =>
    new Promise((resolve, reject) => {
        const child = spawn(config.binaries.celld, args, {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            env: {
                ...options.credentials,
                ...(config.bucket.region === undefined ? {} : { AWS_REGION: config.bucket.region }),
                PATH: CHILD_PATH,
                RUST_LOG: "error,celld=warn",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const lines: string[] = [];
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, options.timeoutMs);
        let timedOut = false;

        timer.unref();

        for (const stream of [child.stdout, child.stderr]) {
            createInterface({ input: stream }).on("line", (line) => {
                lines.push(line);
                options.onLine?.(line);
            });
        }

        child.once("error", (error) => {
            clearTimeout(timer);
            reject(new JobError("CELLD_FAILED", `could not run ${config.binaries.celld}: ${error.message}`));
        });

        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            timedOut = signal === "SIGKILL";

            if (timedOut) {
                reject(new JobError("CELLD_FAILED", `celld ${args[0] ?? ""} did not finish within ${String(options.timeoutMs)} ms`));

                return;
            }

            resolve({ code: code ?? undefined, lines });
        });
    });

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
    options: { credentials: Readonly<Record<string, string>>; onLine: (line: string) => void },
): Promise<string | undefined> => {
    const run = await runCelld(config, ["deploy", directory, ...bucketArgs(config, alias), "--json"], {
        credentials: options.credentials,
        onLine: options.onLine,
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
const celldDiagnose = async (config: HostdConfig, alias: string, credentials: Readonly<Record<string, string>>): Promise<CelldRun> =>
    runCelld(config, ["diagnose", "--json", ...bucketArgs(config, alias)], { credentials, timeoutMs: DIAGNOSE_TIMEOUT_MS });

export type { CelldRun };
export { bucketArgs, celldDeploy, celldDiagnose, runCelld };
