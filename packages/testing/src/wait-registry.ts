/**
 * Event waits shared by every run of one harness. A wait belongs to one run (its
 * workflow instance id), as a Workflows `waitForEvent` does: a delivery or expiry
 * reaches only that run, so two runs may wait on the same event name at once.
 */
/** The name a host gives an elapsed wait; the loop reads it as a timeout. */
const WORKFLOW_TIMEOUT_ERROR_NAME = "WorkflowTimeoutError";

const waitKey = (instanceId: string, name: string): string => JSON.stringify([instanceId, name]);

class WaitRegistry {
    private readonly delivered = new Map<string, unknown>();

    private readonly pending = new Map<string, { reject: (error: Error) => void; resolve: (payload: unknown) => void }>();

    private readonly reached = new Map<string, (() => void)[]>();

    /** The harness's journal: a resolved wait is appended here, in the order it resolves against the run's steps. */
    public constructor(private readonly journal: unknown[]) {}

    public wait(instanceId: string, name: string, type: string): Promise<unknown> {
        const key = waitKey(instanceId, name);

        if (this.delivered.has(key)) {
            const early = this.delivered.get(key);

            this.delivered.delete(key);

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

            for (const listener of this.reached.get(key) ?? []) {
                listener();
            }

            this.reached.delete(key);
        });
    }

    public deliver(instanceId: string, name: string, payload: unknown): void {
        const key = waitKey(instanceId, name);
        const waiting = this.pending.get(key);

        if (waiting === undefined) {
            this.delivered.set(key, payload);

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

        const error = new Error(`agentHarness: wait "${name}" timed out`);

        error.name = WORKFLOW_TIMEOUT_ERROR_NAME;
        waiting.reject(error);
    }

    public awaitWait(instanceId: string, name: string): Promise<void> {
        const key = waitKey(instanceId, name);

        if (this.pending.has(key)) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            this.reached.set(key, [...(this.reached.get(key) ?? []), resolve]);
        });
    }

    private record(name: string, type: string, payload: unknown): unknown {
        this.journal.push({ kind: "wait", name, payload, type });

        return payload;
    }
}

export default WaitRegistry;
