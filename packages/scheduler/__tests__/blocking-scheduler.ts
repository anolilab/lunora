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

/**
 * EVERY `t:` time-index entry carrying `id`, in key order.
 *
 * Prefer this over {@link isIndexed}/{@link indexedAt} whenever a test is about
 * a claim moving between keys. A record is supposed to hold exactly ONE index
 * entry; the interesting failure is two (the record then fires twice), and a
 * predicate that asks whether it has "an" entry is satisfied by both — so the
 * assertion that catches a double-index has to COUNT.
 */
export const indexKeysFor = (storageMap: Map<string, unknown>, id: string): string[] =>
    [...storageMap.keys()]
        .filter((key) => key.startsWith("t:") && key.endsWith(`:${id}`))
        // Code-unit order, NOT locale-aware: these are time-padded index keys
        // whose lexical byte order is their numeric order (see `fake-state`).
        .toSorted((left, right) => {
            if (left < right) {
                return -1;
            }

            return left > right ? 1 : 0;
        });

/** Is `id` still carried by a `t:` time-index entry (i.e. still re-fireable)? */
export const isIndexed = (storageMap: Map<string, unknown>, id: string): boolean => indexKeysFor(storageMap, id).length > 0;

/**
 * The instant `id`'s time-index entry is armed for, or `undefined` when it has
 * none. Throws when the record holds more than one entry rather than silently
 * reporting the earliest: two entries mean two dispatches, and a test reaching
 * for "the" time has already assumed there is only one.
 */
export const indexedAt = (storageMap: Map<string, unknown>, id: string): number | undefined => {
    const keys = indexKeysFor(storageMap, id);

    if (keys.length > 1) {
        throw new Error(`indexedAt(${id}): ${String(keys.length)} index entries, expected at most one — ${keys.join(", ")}`);
    }

    const key = keys[0];

    return key === undefined ? undefined : Number.parseInt(key.slice(2, key.indexOf(":", 2)), 10);
};
