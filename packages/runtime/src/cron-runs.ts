/**
 * The worker's half of the cron no-overlap lease and run history, both of which
 * the `SchedulerDO` holds (`POST /cron/begin`, `POST /cron/end`). Kept apart from
 * `create-worker` so the fail-open policy below has one home.
 *
 * **Fail open.** A run that cannot reach the scheduler still runs, unguarded,
 * exactly as every cron did before the lease existed: a scheduler outage that
 * silently stopped every cron in the app is a worse failure than a rare overlap,
 * and nothing about the job itself is wrong. The miss is logged so it is not
 * silent either.
 */
import type { ResolvedShard } from "./resolve-shard";

/**
 * How often a running job tells the scheduler it is alive. A third of the
 * scheduler's fifteen-minute lease, so two renewals can fail before the lease
 * lapses.
 */
const CRON_LEASE_RENEW_MS = 300_000;

/**
 * What `beginCronRun` decided: run under `runId` (renewing its lease until
 * `endCronRun`), run unguarded (no `runId`), or skip the tick.
 */
type CronRunGate = { renewal?: ReturnType<typeof setInterval>; runId?: string; skip: false } | { reason: string; skip: true };

const describeError = (value: unknown): string => (value instanceof Error ? value.message : JSON.stringify(value));

const post = async (stub: ResolvedShard, path: string, body: unknown): Promise<unknown> => {
    const response = await stub.fetch(
        new Request(`https://scheduler.internal${path}`, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }),
    );

    if (!response.ok) {
        throw new Error(`SchedulerDO ${path} answered ${String(response.status)}`);
    }

    return response.json();
};

/**
 * Renew the lease of run `runId` every {@link CRON_LEASE_RENEW_MS} until
 * `endCronRun` clears the timer. The scheduler treats a lease with no sign of
 * life for fifteen minutes as lost, which is right for a `scheduled()`
 * invocation (torn down at that age) but not for a run with no such bound, such
 * as a manual run from a fetch handler: without renewal the next tick would
 * start a second copy beside it. A renewal that fails is only logged — the
 * lease then lapses as it would have, and the run itself is unaffected — and an
 * answer of `renewed: false` means the lease is no longer this run's, so the
 * timer stops.
 */
const keepLeaseAlive = (stub: ResolvedShard, name: string, runId: string): ReturnType<typeof setInterval> => {
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
        post(stub, "/cron/renew", { name, runId })
            .then((answer) => {
                if ((answer as { renewed?: unknown }).renewed === false) {
                    clearInterval(timer);
                }

                return undefined;
            })
            .catch((error: unknown) => {
                // eslint-disable-next-line no-console -- see beginCronRun
                console.warn(`[lunora] cron job "${name}" could not renew its lease: ${describeError(error)}`);
            });
    }, CRON_LEASE_RENEW_MS);

    return timer;
};

/**
 * Take the in-flight lease for cron job `name`. `stub` is `undefined` when the
 * worker has no `schedulerDO` — then every run is unguarded.
 */
const beginCronRun = async (stub: ResolvedShard | undefined, name: string): Promise<CronRunGate> => {
    if (stub === undefined) {
        return { skip: false };
    }

    try {
        const answer = (await post(stub, "/cron/begin", { name })) as { acquired?: unknown; reason?: unknown; runId?: unknown };

        if (answer.acquired === false) {
            return { reason: typeof answer.reason === "string" ? answer.reason : "in-flight", skip: true };
        }

        const runId = typeof answer.runId === "string" ? answer.runId : undefined;

        return runId === undefined ? { skip: false } : { renewal: keepLeaseAlive(stub, name, runId), runId, skip: false };
    } catch (error: unknown) {
        // eslint-disable-next-line no-console -- the scheduled() entry has no request-scoped logger; the host captures console
        console.warn(`[lunora] cron job "${name}" runs without its overlap guard: ${describeError(error)}`);

        return { skip: false };
    }
};

/** Release `gate`'s lease and record how the run ended. A no-op for an unguarded run; never throws. */
const endCronRun = async (stub: ResolvedShard | undefined, name: string, gate: CronRunGate, error?: unknown): Promise<void> => {
    if (stub === undefined || gate.skip || gate.runId === undefined) {
        return;
    }

    clearInterval(gate.renewal);

    try {
        await post(stub, "/cron/end", {
            name,
            runId: gate.runId,
            ...(error === undefined ? { status: "succeeded" } : { error: describeError(error), status: "failed" }),
        });
    } catch (reportError: unknown) {
        // The lease then lapses on its own fifteen-minute ceiling, recorded as lost.
        // eslint-disable-next-line no-console -- see beginCronRun
        console.warn(`[lunora] cron job "${name}" ran but its outcome was not recorded: ${describeError(reportError)}`);
    }
};

export type { CronRunGate };
export { beginCronRun, CRON_LEASE_RENEW_MS, endCronRun };
