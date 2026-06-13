import type { TokenBucket } from "./token-bucket";

/**
 * Per-cell scheduler (CLOUD-PLAN.md §2.5). Paces and serializes the work a cell
 * sends to Cloudflare — chiefly the Alchemy `finalize()` runs behind the
 * provisioner — against the cell's {@link TokenBucket} budget, with priority
 * ordering and a concurrency cap. A CI stampede degrades to queued-but-ordered,
 * never to dropped API calls.
 *
 * Time is injectable (`now` + `sleep`) so the pacing is deterministic in tests.
 */

export interface CellSchedulerOptions {
    /** The cell's API budget. */
    bucket: TokenBucket;
    /** Max tasks running concurrently. Defaults to 6. */
    maxConcurrent?: number;
    /** Injected clock (ms epoch). Defaults to `Date.now`. */
    now?: () => number;
    /** Injected delay. Defaults to a real `setTimeout`-backed sleep. */
    sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
    /** Higher runs first; ties break FIFO. Defaults to 0. Suggested: interactive deploy > preview > cleanup. */
    priority?: number;
}

interface Job {
    readonly execute: () => Promise<void>;
    readonly priority: number;
    readonly seq: number;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export class CellScheduler {
    private readonly bucket: TokenBucket;

    private inFlight = 0;

    private readonly maxConcurrent: number;

    private readonly now: () => number;

    private pumping = false;

    private readonly queue: Job[] = [];

    private seqCounter = 0;

    private readonly sleep: (ms: number) => Promise<void>;

    public constructor(options: CellSchedulerOptions) {
        this.bucket = options.bucket;
        this.maxConcurrent = options.maxConcurrent ?? 6;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? defaultSleep;
    }

    /** Submit a task; it runs once a token is free and a concurrency slot opens. */
    public run<T>(task: () => Promise<T>, options: RunOptions = {}): Promise<T> {
        let settle!: (value: T) => void;
        let fail!: (reason: unknown) => void;
        const promise = new Promise<T>((resolve, reject) => {
            settle = resolve;
            fail = reject;
        });

        this.seqCounter += 1;
        const job: Job = {
            execute: async () => {
                try {
                    settle(await task());
                } catch (error) {
                    fail(error);
                } finally {
                    this.inFlight -= 1;
                    await this.pump();
                }
            },
            priority: options.priority ?? 0,
            seq: this.seqCounter,
        };

        // Highest priority first; FIFO within a priority (ascending seq).
        const index = this.queue.findIndex((queued) => queued.priority < job.priority);

        if (index === -1) {
            this.queue.push(job);
        } else {
            this.queue.splice(index, 0, job);
        }

        this.pump().catch(() => {});

        return promise;
    }

    private async pump(): Promise<void> {
        if (this.pumping) {
            return;
        }

        this.pumping = true;

        try {
            while (this.queue.length > 0 && this.inFlight < this.maxConcurrent) {
                if (this.bucket.tryRemove(this.now())) {
                    const job = this.queue.shift();

                    if (job) {
                        this.inFlight += 1;
                        job.execute().catch(() => {});
                    }

                    continue;
                }

                // Out of budget — wait for the next token, then re-evaluate.
                // eslint-disable-next-line no-await-in-loop -- intentional: serialize until a token frees
                await this.sleep(this.bucket.msUntilNext(this.now()));
            }
        } finally {
            this.pumping = false;
        }
    }
}
