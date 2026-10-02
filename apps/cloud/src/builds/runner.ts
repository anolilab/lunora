/**
 * Build-runner orchestration (GAPS.md A3). Pure over injected ports: the
 * source fetch (GitHub tarball via an App installation token) and the build
 * execution (a throwaway Cloudflare Container running `lunora build` — the
 * `@lunora/container` seam) are 🌐; this module owns the order of operations —
 * claim → fetch → execute (streaming logs) → complete/fail — so the whole flow
 * unit-tests with fakes.
 */

export interface ClaimedBuild {
    buildId: string;
    commitSha: string;
    projectId: string; // secret-scanner:allow -- domain field name
    /** Repo-relative directory the build runs in; absent means the repository root. */
    rootDirectory?: string;
}

/**
 * What a build produced: everything the deploy path needs to release it, as the
 * project's own `lunora cloud deploy --out` described it in the build box.
 *
 * `manifest`, `assets` and `cronSpecs` are wire data from a box that ran tenant
 * code, so they stay `unknown`-ish here; the deploy path validates them exactly
 * as it validates a `POST /v1/deploy` body.
 */
export interface BuildExecution {
    /** The static files behind the manifest's `assets` binding, when there is one. */
    assets?: unknown;
    /** Base64-encoded worker bundle. */
    bundle: string;
    bundleHash: string;
    /** The tenant's cron expressions (wrangler `triggers.crons`). */
    cronSpecs?: string[];

    /**
     * The Worker's binding manifest. Absent only from a build box that predates
     * release payloads, whose builds cannot be released — the release refuses
     * rather than deploying a Worker with none of its bindings.
     */
    manifest?: Record<string, unknown>;
    /** The wrangler `name`, a hint for a project's first production alias. */
    scriptName?: string;
}

/** What the release port reports: the deployment it recorded, and how it ended. */
export interface BuildRelease {
    deploymentId: string;
    /** Set when the deployment was recorded but did not go live. */
    error?: string;
    kind: "preview" | "production";
    url?: string;
}

/** The release port declined to release the build, and why (a fork's pull request). */
export interface BuildReleaseSkipped {
    skipped: string;
}

export interface BuildRunnerPorts {
    /** Stream one output line into `buildLogs` (lease-checked upstream). */
    appendLog: (buildId: string, level: "error" | "info", line: string) => Promise<void>;
    /** Mark the build successful with its bundle hash, linking the deployment it fed when there is one. */
    complete: (buildId: string, bundleHash: string, deploymentId?: string) => Promise<void>;
    /** Run the build over the fetched source in `rootDirectory`, streaming output via `onLine`. 🌐 in production. */
    execute: (source: ArrayBuffer, rootDirectory: string | undefined, onLine: (line: string) => Promise<void>) => Promise<BuildExecution>;
    /** Mark the build failed. */
    fail: (buildId: string, error: string) => Promise<void>;
    /** Fetch the repo tarball at the build's commit (GitHub App token). 🌐 in production. */
    fetchSource: (build: ClaimedBuild) => Promise<ArrayBuffer>;

    /**
     * Build → deploy handoff (GAPS.md A3): feed the build into the same release
     * core `POST /v1/deploy` runs (`src/builds/release.ts`). Runs while the build
     * still holds its lease, so the release's progress lands in `buildLogs`. A
     * release failure fails the *deploy*, never the completed build — it either
     * throws (nothing was recorded) or answers with `error` (a deployment was
     * recorded and failed), or answers `skipped` when the build must not be
     * released at all. Omit for build-only runs.
     */
    release?: (build: ClaimedBuild, execution: BuildExecution) => Promise<BuildRelease | BuildReleaseSkipped>;

    /**
     * Report the build's state back to the commit that triggered it (GAPS.md A4)
     * — the half of push-to-deploy that was missing, where the person who pushed
     * finds out what happened without opening the dashboard.
     *
     * Optional, and every call is swallowed: this is a notification about work
     * that has already happened, so a GitHub outage, a revoked installation or an
     * absent App credential must never change a build's outcome.
     */
    reportStatus?: (build: ClaimedBuild, state: "failure" | "pending" | "success", description: string, targetUrl?: string) => Promise<void>;
}

/**
 * Cloudflare's wall-clock cap on one scheduled (Cron Trigger) invocation: the
 * runtime waits for `scheduled()` "up to a maximum of 15 minutes", and
 * `ctx.waitUntil` work must settle "before the invocation completes" — it buys
 * no extra time. The build drain runs inside the every-minute tick, so a build
 * AND its release have to fit in it.
 * https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
 * https://developers.cloudflare.com/workers/platform/limits/ (Cron Triggers: 15 min duration)
 */
export const SCHEDULED_INVOCATION_LIMIT_MS = 15 * 60 * 1000;

/**
 * How long one build's execution may run, leaving the rest of the invocation
 * for fetching the source before it and the release after it. A build past it
 * fails with the reason instead of being cut off mid-flight, which would leave
 * its row `building` until the stale-lease recovery rebuilt it, forever.
 */
export const BUILD_EXECUTE_BUDGET_MS = 9 * 60 * 1000;

/** `work`, or a rejection naming the budget once `budgetMs` passes. The timer never outlives the work. */
export const withinBudget = async <T>(work: Promise<T>, budgetMs: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(
                new Error(
                    `${what} ran past ${String(Math.round(budgetMs / 60_000))} minutes, the most one scheduled invocation leaves it (Cloudflare stops a Cron Trigger invocation after ${String(SCHEDULED_INVOCATION_LIMIT_MS / 60_000)} minutes); make the install or build faster`,
                ),
            );
        }, budgetMs);
    });

    try {
        return await Promise.race([work, expired]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * The marker the build dispatcher's `unconfigured()` ports (`control-plane.ts`) put in their message.
 *
 * Shared rather than duplicated as a string literal, because two places have to
 * agree on it and a typo in either silently restores the noise below.
 */
export const UNCONFIGURED_MARKER = "is not configured:";

/**
 * Is this failure the platform's own missing infrastructure rather than anything
 * about the user's code?
 *
 * A build cannot run until the control plane has GitHub App credentials and a
 * build container, and until then every queued build fails at the first port with
 * an `unconfigured()` error. Reporting THAT is worse than silence: the moment the
 * App credential is provisioned — which lights the reporter but not the executor
 * — every push to every connected repository would get a red `lunora/deploy`
 * check reading "build execution is not configured", and every org with a deploy
 * alert rule would be paged for it. Users would learn to ignore both, which is
 * the failure mode a notification feature never recovers from.
 *
 * The build is still marked failed and its reason still lands in `buildLogs`, so
 * an operator sees it. Only the outward notification is suppressed.
 */
export const isUnconfiguredInfrastructure = (message: string): boolean => message.includes(UNCONFIGURED_MARKER);

/**
 * Report a build's state, swallowing anything the report itself throws.
 *
 * `try`/`catch` rather than `.catch()`: the promise form only absorbs a
 * REJECTION, so a port that threw synchronously escaped into `runBuild`'s outer
 * catch and marked the build failed — a notification failure changing the outcome
 * of the work it was reporting on, which is the one thing this must never do.
 */
const report = async (
    ports: BuildRunnerPorts,
    build: ClaimedBuild,
    state: "failure" | "pending" | "success",
    description: string,
    targetUrl?: string,
): Promise<void> => {
    try {
        await ports.reportStatus?.(build, state, description, targetUrl);
    } catch {
        // Best-effort by design — see above.
    }
};

/**
 * The BUILD succeeded, but nothing was deployed — so the commit must not read
 * green. Reporting the build's own outcome here would tell the pusher their
 * change is live when it is not, which is the one wrong answer available.
 */
const reportReleaseFailure = async (ports: BuildRunnerPorts, build: ClaimedBuild, message: string, targetUrl?: string): Promise<void> => {
    await report(ports, build, "failure", `Build succeeded but the release failed: ${message}`, targetUrl);
};

export type BuildOutcome = { bundleHash: string; deploymentId?: string; status: "successful" } | { error: string; status: "failed" };

/** Drive one claimed build through fetch → execute → complete/fail. Never throws. */
export const runBuild = async (build: ClaimedBuild, ports: BuildRunnerPorts): Promise<BuildOutcome> => {
    try {
        await report(ports, build, "pending", "Building on Lunora Cloud…");

        await ports.appendLog(build.buildId, "info", `fetching source at ${build.commitSha}`);

        const source = await ports.fetchSource(build);

        await ports.appendLog(build.buildId, "info", "running build");

        const result = await ports.execute(source, build.rootDirectory, (line) => ports.appendLog(build.buildId, "info", line));

        if (!ports.release) {
            await ports.complete(build.buildId, result.bundleHash);
            await report(ports, build, "success", "Built on Lunora Cloud.");

            return { bundleHash: result.bundleHash, status: "successful" };
        }

        // Released BEFORE `complete`: completing drops the lease, and the release's
        // progress lines are written under it. The build is done regardless of what
        // happens next — a failed release is reported, never turned into a failed
        // build, and the artifact stays reusable (dedup).
        let released: BuildRelease | BuildReleaseSkipped;

        try {
            released = await ports.release(build, result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            await ports.appendLog(build.buildId, "error", `release failed: ${message}`).catch(() => {});
            await ports.complete(build.buildId, result.bundleHash);
            await reportReleaseFailure(ports, build, message);

            return { bundleHash: result.bundleHash, status: "successful" };
        }

        if ("skipped" in released) {
            await ports.appendLog(build.buildId, "info", `release skipped: ${released.skipped}`).catch(() => {});
            await ports.complete(build.buildId, result.bundleHash);
            await report(ports, build, "success", `Built on Lunora Cloud; ${released.skipped}.`);

            return { bundleHash: result.bundleHash, status: "successful" };
        }

        // Logged before `complete`, like every line: completing releases the lease
        // that `appendLog` checks.
        await (
            released.error === undefined
                ? ports.appendLog(build.buildId, "info", `released as deployment ${released.deploymentId}`)
                : ports.appendLog(build.buildId, "error", `release failed: deployment ${released.deploymentId} ended failed: ${released.error}`)
        ).catch(() => {});
        await ports.complete(build.buildId, result.bundleHash, released.deploymentId);

        if (released.error !== undefined) {
            await reportReleaseFailure(ports, build, released.error, released.url);

            return { bundleHash: result.bundleHash, deploymentId: released.deploymentId, status: "successful" };
        }

        // The URL is the whole point of reporting back: a green check that does
        // not link anywhere still leaves the pusher opening the dashboard to find
        // out where their change went.
        await report(
            ports,
            build,
            "success",
            released.kind === "production" ? "Deployed to production on Lunora Cloud." : "Deployed to a preview on Lunora Cloud.",
            released.url,
        );

        return { bundleHash: result.bundleHash, deploymentId: released.deploymentId, status: "successful" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await ports.appendLog(build.buildId, "error", message).catch(() => {});
        await ports.fail(build.buildId, message).catch(() => {});

        if (!isUnconfiguredInfrastructure(message)) {
            await report(ports, build, "failure", message);
        }

        return { error: message, status: "failed" };
    }
};
