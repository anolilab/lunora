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
}

export interface BuildExecution {
    /** Base64-encoded worker bundle, ready for `POST /v1/deploy`. */
    bundle: string;
    bundleHash: string;
}

export interface BuildRunnerPorts {
    /** Stream one output line into `buildLogs` (lease-checked upstream). */
    appendLog: (buildId: string, level: "error" | "info", line: string) => Promise<void>;
    /** Mark the build successful with its bundle hash. */
    complete: (buildId: string, bundleHash: string) => Promise<void>;
    /** Run the build over the fetched source, streaming output via `onLine`. 🌐 in production. */
    execute: (source: ArrayBuffer, onLine: (line: string) => Promise<void>) => Promise<BuildExecution>;
    /** Mark the build failed. */
    fail: (buildId: string, error: string) => Promise<void>;
    /** Fetch the repo tarball at the build's commit (GitHub App token). 🌐 in production. */
    fetchSource: (build: ClaimedBuild) => Promise<ArrayBuffer>;

    /**
     * Build → deploy handoff (GAPS.md ring-2): feed the built bundle into the
     * release path (`POST /v1/deploy` with the project's deploy key — the
     * health-gated blue/green pipeline takes it from there). A release failure
     * fails the *deploy*, never the completed build. Omit for build-only runs.
     */
    release?: (build: ClaimedBuild, execution: BuildExecution) => Promise<{ deploymentId: string; url?: string }>;

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
 * The marker `builds.dispatch`'s `unconfigured()` ports put in their message.
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

export type BuildOutcome = { bundleHash: string; deploymentId?: string; status: "successful" } | { error: string; status: "failed" };

/** Drive one claimed build through fetch → execute → complete/fail. Never throws. */
export const runBuild = async (build: ClaimedBuild, ports: BuildRunnerPorts): Promise<BuildOutcome> => {
    try {
        await report(ports, build, "pending", "Building on Lunora Cloud…");

        await ports.appendLog(build.buildId, "info", `fetching source at ${build.commitSha}`);

        const source = await ports.fetchSource(build);

        await ports.appendLog(build.buildId, "info", "running build");

        const result = await ports.execute(source, (line) => ports.appendLog(build.buildId, "info", line));

        await ports.complete(build.buildId, result.bundleHash);

        // The build is done regardless of what happens next; a failed release
        // is reported in the logs but keeps the artifact reusable (dedup).
        if (ports.release) {
            try {
                const { deploymentId, url } = await ports.release(build, result);

                await ports.appendLog(build.buildId, "info", `released as deployment ${deploymentId}`);
                // The preview URL is the whole point of reporting back: a green check
                // that does not link anywhere still leaves the pusher opening the
                // dashboard to find out where their change went.
                await report(ports, build, "success", "Deployed to a preview on Lunora Cloud.", url);

                return { bundleHash: result.bundleHash, deploymentId, status: "successful" };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);

                await ports.appendLog(build.buildId, "error", `release failed: ${message}`).catch(() => {});
                // The BUILD succeeded and its artifact stays reusable, but nothing
                // was deployed — so the commit must not read green. Reporting the
                // build's own outcome here would tell the pusher their change is
                // live when it is not, which is the one wrong answer available.
                await report(ports, build, "failure", `Build succeeded but the release failed: ${message}`);

                return { bundleHash: result.bundleHash, status: "successful" };
            }
        }

        await report(ports, build, "success", "Built on Lunora Cloud.");

        return { bundleHash: result.bundleHash, status: "successful" };
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
