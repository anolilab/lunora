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
}

export type BuildOutcome = { bundleHash: string; status: "successful" } | { error: string; status: "failed" };

/** Drive one claimed build through fetch → execute → complete/fail. Never throws. */
export const runBuild = async (build: ClaimedBuild, ports: BuildRunnerPorts): Promise<BuildOutcome> => {
    try {
        await ports.appendLog(build.buildId, "info", `fetching source at ${build.commitSha}`);

        const source = await ports.fetchSource(build);

        await ports.appendLog(build.buildId, "info", "running build");

        const result = await ports.execute(source, (line) => ports.appendLog(build.buildId, "info", line));

        await ports.complete(build.buildId, result.bundleHash);

        return { bundleHash: result.bundleHash, status: "successful" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await ports.appendLog(build.buildId, "error", message).catch(() => {});
        await ports.fail(build.buildId, message).catch(() => {});

        return { error: message, status: "failed" };
    }
};
