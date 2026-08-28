/**
 * Stamp `readyAt` on `.lunora/dev.json` once the recorded server answers.
 *
 * The record is claimed BEFORE the server is spawned, so its `url` is the origin
 * the server intends to serve on and its `pid` is a process that merely exists.
 * That is enough to find and stop a server, and not enough for a task runner
 * supervising Lunora as one worker among several: it cannot tell a starting
 * server from a serving one, so it sleeps a guessed interval and races on a cold
 * cache.
 *
 * `--background` already waited for readiness before printing its banner — it
 * just never wrote the answer down, so only that one command could act on it.
 * This persists the same fact, from the same probe, for everyone else.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { readDevServerState, updateDevServerState } from "@lunora/config";

import type { ReadinessProbe } from "./dev-probe";
import { defaultProbe, POLL_INTERVAL_MS, resolveReadyTimeoutMs } from "./dev-probe";
import type { Logger } from "./logger";

/**
 * Poll until the server at `origin` answers, then record `readyAt`.
 *
 * Never throws and never rejects: this is metadata for whoever is watching, and
 * a probe failure must not disturb the server it observes. Returns whether
 * readiness was recorded, so a caller or a test can tell "answered" from "gave
 * up / was cancelled" without re-reading the file.
 */
const markWorkerReadyWhenServing = async (options: {
    /** Project root holding `.lunora/dev.json`. */
    cwd: string;
    logger: Logger;
    /** The origin the server serves on (`plan.workerOrigin`). */
    origin: string;
    /** Injection seam for tests — defaults to the shared {@link defaultProbe}. */
    probe?: ReadinessProbe;
    /** Overall budget; defaults to the shared ready timeout (env-overridable). */
    readyTimeoutMs?: number;
    /** Aborted on shutdown, so the loop stops with the server rather than outliving it. */
    signal: AbortSignal;
}): Promise<boolean> => {
    const { cwd, logger, origin, signal } = options;
    const probe = options.probe ?? defaultProbe;
    const timeoutMs = resolveReadyTimeoutMs(options.readyTimeoutMs);
    const deadline = Date.now() + timeoutMs;

    while (!signal.aborted && Date.now() < deadline) {
        let answered = false;

        try {
            // eslint-disable-next-line no-await-in-loop -- readiness polling: each tick re-samples the socket
            answered = await probe(origin);
        } catch {
            // A probe is allowed to reject; "never rejects" is this function's
            // contract, not its collaborator's. The caller floats this promise,
            // so letting one through would surface as an unhandled rejection
            // that takes down the dev server the probe only meant to observe.
        }

        if (answered) {
            // Only while the record is still OURS. Every other mutation of this
            // file is ownership-checked (`claimDevServerState`'s exclusive
            // create, `clearDevServerState(cwd, expectedPid)`), and a late stamp
            // is exactly the case that needs it: this process's server can answer
            // after a newer one has claimed the record, and an unguarded patch
            // would mark that newer server ready on our behalf.
            updateDevServerState(cwd, { readyAt: new Date().toISOString() }, { expectedPid: process.pid });

            return readDevServerState(cwd)?.readyAt !== undefined;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- the gap between attempts IS the loop
            await sleep(POLL_INTERVAL_MS, undefined, { signal });
        } catch {
            // Aborted mid-sleep — the loop condition ends it on the next pass.
        }
    }

    // Only worth saying when we ran out of patience. A cancelled probe means the
    // server is shutting down, where a warning about readiness is noise.
    if (!signal.aborted) {
        logger.warn(
            `server did not answer on ${origin} within ${String(Math.round(timeoutMs / 1000))}s — ` +
                `.lunora/dev.json will have no readyAt, so anything polling for readiness will keep waiting. ` +
                `The server itself is unaffected; raise LUNORA_DEV_READY_TIMEOUT_MS if it is just slow to boot.`,
        );
    }

    return false;
};

export default markWorkerReadyWhenServing;
