/**
 * Event waits shared by every run of one harness. A wait belongs to one run (its
 * workflow instance id), as a Workflows `waitForEvent` does: a delivery or expiry
 * reaches only that run, so two runs may wait on the same event name at once.
 */
/** The name a host gives an elapsed wait; the loop reads it as a timeout. */
const WORKFLOW_TIMEOUT_ERROR_NAME = "WorkflowTimeoutError";

const waitKey = (instanceId: string, name: string): string => JSON.stringify([instanceId, name]);

interface ReachListener {
    resolve: () => void;
    /** The 1-based wait this listener is waiting for: the Nth wait the run starts on the name. */
    target: number;
}

class WaitRegistry {
    private readonly awaited = new Map<string, number>();

    private readonly delivered = new Map<string, unknown>();

    /**
     * Keys whose latest wait timed out. A delivery while one is set is late, so it is
     * dropped rather than held: the run's next wait on the name starts a fresh generation.
     */
    private readonly expired = new Set<string>();

    private readonly pending = new Map<string, { reject: (error: Error) => void; resolve: (payload: unknown) => void }>();

    private readonly reached = new Map<string, ReachListener[]>();

    /** How many waits each run has started, per event name. Kept after a wait completes, so a late observer still sees it. */
    private readonly started = new Map<string, number>();

    /** The journal: a resolved wait is appended here, in the order it resolves against the run's steps. */
    public constructor(private readonly journal: unknown[]) {}

    public wait(instanceId: string, name: string, type: string): Promise<unknown> {
        const key = waitKey(instanceId, name);
        const count = (this.started.get(key) ?? 0) + 1;

        this.started.set(key, count);
        this.expired.delete(key);

        if (this.delivered.has(key)) {
            const early = this.delivered.get(key);

            this.delivered.delete(key);
            this.notifyReached(key, count);

            return Promise.resolve(this.record(name, type, early));
        }

        return new Promise<unknown>((resolve, reject) => {
            // A second wait on the same key would orphan the first one's resolver, so it is refused.
            if (this.pending.has(key)) {
                reject(new Error(`agentHarness: run "${instanceId}" is already waiting on "${name}"`));

                return;
            }

            this.pending.set(key, {
                reject,
                resolve: (payload) => {
                    resolve(this.record(name, type, payload));
                },
            });

            this.notifyReached(key, count);
        });
    }

    public deliver(instanceId: string, name: string, payload: unknown): void {
        const key = waitKey(instanceId, name);
        const waiting = this.pending.get(key);

        if (waiting === undefined) {
            if (!this.expired.has(key)) {
                this.delivered.set(key, payload);
            }

            return;
        }

        this.pending.delete(key);
        waiting.resolve(payload);
    }

    public expire(instanceId: string, name: string): void {
        const key = waitKey(instanceId, name);
        const waiting = this.pending.get(key);

        if (waiting === undefined) {
            throw new Error(`agentHarness: no pending wait "${name}" on run "${instanceId}" to expire`);
        }

        this.pending.delete(key);
        this.expired.add(key);

        const error = new Error(`agentHarness: wait "${name}" timed out`);

        error.name = WORKFLOW_TIMEOUT_ERROR_NAME;
        waiting.reject(error);
    }

    /**
     * Resolves once the run has started its next wait on `name` that this observer has not
     * yet been handed. A wait the run already started and finished still counts, so a test
     * that asks late gets an answer instead of waiting for a wait that will not come again.
     */
    public awaitWait(instanceId: string, name: string): Promise<void> {
        const key = waitKey(instanceId, name);
        const target = (this.awaited.get(key) ?? 0) + 1;

        this.awaited.set(key, target);

        if ((this.started.get(key) ?? 0) >= target) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            this.reached.set(key, [...(this.reached.get(key) ?? []), { resolve, target }]);
        });
    }

    /** Resolve every observer waiting for the `count`th wait on `key` or an earlier one. */
    private notifyReached(key: string, count: number): void {
        const listeners = this.reached.get(key) ?? [];

        this.reached.set(
            key,
            listeners.filter((listener) => listener.target > count),
        );

        for (const listener of listeners) {
            if (listener.target <= count) {
                listener.resolve();
            }
        }
    }

    private record(name: string, type: string, payload: unknown): unknown {
        this.journal.push({ kind: "wait", name, payload, type });

        return payload;
    }
}

export default WaitRegistry;
