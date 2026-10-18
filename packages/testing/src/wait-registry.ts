/**
 * Event waits shared by every run of one harness: a run's `waitForEvent` resolves
 * from here, so a test can deliver or expire the event at a point it chooses.
 */
/** The name a host gives an elapsed wait; the loop reads it as a timeout. */
const WORKFLOW_TIMEOUT_ERROR_NAME = "WorkflowTimeoutError";

class WaitRegistry {
    /** Every wait a run resolved, in order: the payload the journal recorded for it. */
    public readonly records: { name: string; payload: unknown; type: string }[] = [];

    private readonly delivered = new Map<string, unknown>();

    private readonly pending = new Map<string, { reject: (error: Error) => void; resolve: (payload: unknown) => void }>();

    private readonly reached = new Map<string, (() => void)[]>();

    public wait(name: string, type: string): Promise<unknown> {
        const early = this.delivered.get(name);

        if (this.delivered.has(name)) {
            this.delivered.delete(name);

            return Promise.resolve(this.record(name, type, early));
        }

        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(name, {
                reject,
                resolve: (payload) => {
                    resolve(this.record(name, type, payload));
                },
            });

            for (const listener of this.reached.get(name) ?? []) {
                listener();
            }

            this.reached.delete(name);
        });
    }

    public deliver(name: string, payload: unknown): void {
        const waiting = this.pending.get(name);

        if (waiting === undefined) {
            this.delivered.set(name, payload);

            return;
        }

        this.pending.delete(name);
        waiting.resolve(payload);
    }

    public expire(name: string): void {
        const waiting = this.pending.get(name);

        if (waiting === undefined) {
            throw new Error(`agentHarness: no pending wait "${name}" to expire`);
        }

        this.pending.delete(name);

        const error = new Error(`agentHarness: wait "${name}" timed out`);

        error.name = WORKFLOW_TIMEOUT_ERROR_NAME;
        waiting.reject(error);
    }

    public awaitWait(name: string): Promise<void> {
        if (this.pending.has(name)) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            this.reached.set(name, [...(this.reached.get(name) ?? []), resolve]);
        });
    }

    private record(name: string, type: string, payload: unknown): unknown {
        this.records.push({ name, payload, type });

        return payload;
    }
}

export default WaitRegistry;
