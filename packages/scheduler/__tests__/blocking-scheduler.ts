import { SchedulerDO } from "../src/scheduler-do";
import type { ScheduleRecord } from "../src/types";

/**
 * A scheduler whose `dispatch()` blocks until the test releases it, recording
 * the id of every record whose dispatch has begun.
 *
 * Holding a dispatch open deliberately — a promise the test resolves, never a
 * timer — is what makes "did these overlap?" and "what do the durable rows look
 * like WHILE a dispatch is in flight?" deterministic questions.
 *
 * What this double CANNOT prove: it replaces the HTTP hop entirely, so it says
 * nothing about Cloudflare's six-simultaneous-connection ceiling, about the
 * 15-minute alarm wall clock, or about how the real runtime receiver behaves.
 * It proves only the DO-side question — how many dispatches this class allows
 * to be in flight at once, and how the durable rows settle around them.
 */
export class BlockingScheduler extends SchedulerDO {
    /** Ids whose `dispatch()` has been entered, in entry order. */
    public readonly started: string[] = [];

    /** Ids whose `dispatch()` has returned. */
    public readonly finished: string[] = [];

    /** Per-id resolver; calling it lets that dispatch return. */
    private readonly gates = new Map<string, (ok: boolean) => void>();

    /** Release one in-flight dispatch with the given outcome. */
    public release(id: string, ok = true): void {
        const gate = this.gates.get(id);

        if (gate === undefined) {
            throw new Error(`release(${id}): that dispatch is not in flight`);
        }

        this.gates.delete(id);
        gate(ok);
    }

    /** Release every in-flight dispatch. */
    public releaseAll(ok = true): void {
        for (const id of this.gates.keys()) {
            this.release(id, ok);
        }
    }

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.started.push(record.id);

        const ok = await new Promise<boolean>((resolve) => {
            this.gates.set(record.id, resolve);
        });

        this.finished.push(record.id);

        return ok;
    }
}

/**
 * Let every pending continuation run. A macrotask hop drains the whole microtask
 * queue behind it, so after this the only thing still unresolved is a dispatch
 * the test is deliberately holding open.
 */
export const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
};

export const post = (path: string, body: unknown): Request =>
    new Request(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** Schedule `count` already-due jobs named `job-0`…, returning their ids. */
export const scheduleDue = async (scheduler: SchedulerDO, count: number, extra: Record<string, unknown> = {}): Promise<string[]> => {
    const ids: string[] = [];

    for (let index = 0; index < count; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- ids must be minted in a deterministic order
        const response = await scheduler.fetch(
            post("/schedule", {
                args: {},
                functionPath: `jobs.run${String(index)}`,
                id: `job-${String(index)}`,
                scheduledFor: Date.now() - 1000,
                ...extra,
            }),
        );

        // eslint-disable-next-line no-await-in-loop -- see above
        const body = await response.json<{ id: string }>();

        ids.push(body.id);
    }

    return ids;
};

/** Is `id` still carried by a `t:` time-index entry (i.e. still re-fireable)? */
export const isIndexed = (storageMap: Map<string, unknown>, id: string): boolean =>
    [...storageMap.keys()].some((key) => key.startsWith("t:") && key.endsWith(`:${id}`));

/** The instant `id`'s `t:` time-index entry is armed for, or `undefined` when it has none. */
export const indexedAt = (storageMap: Map<string, unknown>, id: string): number | undefined => {
    const key = [...storageMap.keys()].find((candidate) => candidate.startsWith("t:") && candidate.endsWith(`:${id}`));

    return key === undefined ? undefined : Number.parseInt(key.slice(2, key.indexOf(":", 2)), 10);
};
