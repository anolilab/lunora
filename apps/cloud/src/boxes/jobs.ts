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
    onProgress: (line: string) => void;
    settle: (outcome: JobOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Most jobs one box may have in flight; a job past it is refused rather than queued (plan 458 D14). */
export const MAX_JOBS_IN_FLIGHT = 16;

export class JobRegistry {
    private readonly pending = new Map<string, PendingJob>();

    /** Jobs waiting for their `result`. */
    public get size(): number {
        return this.pending.size;
    }

    /**
     * Wait for `jobId`'s result. Resolves — never rejects — with the box's
     * result, or with a synthetic failure when the job times out or is failed
     * by {@link failAll}.
     */
    public start(jobId: string, options: { onProgress: (line: string) => void; timeoutMs: number }): Promise<JobOutcome> {
        return new Promise<JobOutcome>((resolve) => {
            const timer = setTimeout(() => {
                this.finish(jobId, {
                    error: { code: "JOB_TIMEOUT", message: `the box did not finish the job within ${String(options.timeoutMs)} ms` },
                    ok: false,
                });
            }, options.timeoutMs);

            this.pending.set(jobId, { onProgress: options.onProgress, settle: resolve, timer });
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
