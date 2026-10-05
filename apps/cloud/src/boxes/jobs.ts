/**
 * Job correlation for one box session (plan 458 G11): each `job` frame carries
 * a fresh `jobId`; the box streams `progress` for it and ends it with exactly
 * one `result`. A job ends early when it times out or the box's socket goes,
 * so a caller never waits on a box that will not answer.
 *
 * In memory: a job only lives as long as the request that dispatched it, and
 * that request keeps its Durable Object awake (and un-hibernated) until then.
 */
import type { ProgressMessage, ResultMessage } from "@lunora/hostd/protocol";

/** How a job ended, for a caller that does not care how a box phrases it. */
export type JobOutcome = Pick<ResultMessage, "error" | "ok" | "url">;

interface PendingJob {
    /** Whether the job counts against {@link MAX_JOBS_IN_FLIGHT}. */
    counted: boolean;
    onProgress: (line: string) => void;
    /** The socket the job was sent on: the one place its `result` can come from. */
    owner: unknown;
    settle: (outcome: JobOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Most jobs one box may have in flight; a job past it is refused rather than queued (plan 458 D14). */
export const MAX_JOBS_IN_FLIGHT = 16;

export class JobRegistry {
    private readonly pending = new Map<string, PendingJob>();

    /**
     * Jobs waiting for their `result` that count against
     * {@link MAX_JOBS_IN_FLIGHT}. A fire-and-forget job started with `counted:
     * false` (the `upgrade` replayed on every reconnect) waits without taking a
     * slot a caller's deploy needs.
     */
    public get size(): number {
        let counted = 0;

        for (const job of this.pending.values()) {
            if (job.counted) {
                counted += 1;
            }
        }

        return counted;
    }

    /**
     * Wait for `jobId`'s result. Resolves — never rejects — with the box's
     * result, or with a synthetic failure when the job times out or is failed
     * by {@link failAll} or {@link failOwner}. `owner` is the socket the job
     * was sent on.
     */
    public start(jobId: string, options: { counted?: boolean; onProgress: (line: string) => void; owner?: unknown; timeoutMs: number }): Promise<JobOutcome> {
        return new Promise<JobOutcome>((resolve) => {
            const timer = setTimeout(() => {
                this.finish(jobId, {
                    error: { code: "JOB_TIMEOUT", message: `the box did not finish the job within ${String(options.timeoutMs)} ms` },
                    ok: false,
                });
            }, options.timeoutMs);

            this.pending.set(jobId, { counted: options.counted ?? true, onProgress: options.onProgress, owner: options.owner, settle: resolve, timer });
        });
    }

    /** Forward a `progress` line to its job. A line for a job that is not pending is dropped: it is untrusted input. */
    public progress(message: ProgressMessage): void {
        this.pending.get(message.jobId)?.onProgress(message.line);
    }

    /** Settle a job with the box's `result`. A result for a job that is not pending is dropped. */
    public result(message: ResultMessage): void {
        this.finish(message.jobId, {
            ok: message.ok,
            ...(message.error === undefined ? {} : { error: message.error }),
            ...(message.url === undefined ? {} : { url: message.url }),
        });
    }

    /** Fail every pending job — the box's socket is gone, and no `result` will come. */
    public failAll(code: string, message: string): void {
        // Deleting the entry being visited is safe while iterating a Map.
        for (const jobId of this.pending.keys()) {
            this.finish(jobId, { error: { code, message }, ok: false });
        }
    }

    /**
     * Fail every pending job sent on `owner` — its socket was superseded or
     * closed, so no `result` for them will ever come, even while the box itself
     * stays connected on a newer socket.
     */
    public failOwner(owner: unknown, code: string, message: string): void {
        for (const [jobId, job] of this.pending) {
            if (job.owner === owner) {
                this.finish(jobId, { error: { code, message }, ok: false });
            }
        }
    }

    private finish(jobId: string, outcome: JobOutcome): void {
        const job = this.pending.get(jobId);

        if (job === undefined) {
            return;
        }

        this.pending.delete(jobId);
        clearTimeout(job.timer);
        job.settle(outcome);
    }
}
