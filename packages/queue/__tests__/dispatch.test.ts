import { describe, expect, it, vi } from "vitest";

import { defineQueue } from "../src/define-queue";
import type { CapturedQueueMessage, QueueCaptureSink } from "../src/dispatch";
import { dispatchQueueBatch } from "../src/dispatch";
import type { MessageBatchLike, MessageLike } from "../src/types";

/** `true` only when `Keys` and `Canonical` are mutually assignable (the exact same key set). */
type KeysMatch<Keys extends string, Canonical extends string> = [Keys] extends [Canonical] ? ([Canonical] extends [Keys] ? true : never) : never;

/**
 * Canonical key set of `CapturedQueueMessage` — the record `dispatchQueueBatch`
 * hands the sink. `@lunora/do`'s `RecordQueueMessageInput` is its structural mirror
 * across the deliberate no-dependency-edge boundary and duplicates this exact tuple
 * in its own drift guard (`shard-do.admin.test.ts`), so a field added to / dropped
 * from either side fails that side's build before a capture write loses or forges a
 * column. `error` is optional.
 */
const CAPTURED_QUEUE_MESSAGE_KEYS = ["attempts", "body", "deadLettered", "error", "exportName", "messageId", "outcome", "queue", "timestamp"] as const;

// Compile-time drift guard: assigning `true` fails tsc the moment the key sets diverge.
const CAPTURED_QUEUE_MESSAGE_KEY_GUARD: KeysMatch<keyof CapturedQueueMessage, (typeof CAPTURED_QUEUE_MESSAGE_KEYS)[number]> = true;

describe("captured-message wire shape (CapturedQueueMessage)", () => {
    it("keeps its keys in lockstep with @lunora/do's RecordQueueMessageInput", () => {
        expect.assertions(2);

        expect(CAPTURED_QUEUE_MESSAGE_KEY_GUARD).toBe(true);
        expect([...CAPTURED_QUEUE_MESSAGE_KEYS]).toStrictEqual([
            "attempts",
            "body",
            "deadLettered",
            "error",
            "exportName",
            "messageId",
            "outcome",
            "queue",
            "timestamp",
        ]);
    });
});

const message = <Body>(body: Body): MessageLike<Body> & { acked: boolean } => {
    const m = {
        ack: vi.fn<() => void>(() => {
            m.acked = true;
        }),
        acked: false,
        attempts: 1,
        body,
        id: "m1",
        retry: vi.fn<() => void>(),
        timestamp: new Date(0),
    };

    return m;
};

const batch = <Body>(queue: string, messages: MessageLike<Body>[]): MessageBatchLike<Body> => {
    return {
        ackAll: vi.fn<() => void>(),
        messages,
        queue,
        retryAll: vi.fn<() => void>(),
    };
};

describe("dispatchQueueBatch", () => {
    it("routes a batch to the matching push handler and runs it", async () => {
        expect.assertions(2);

        const seen: unknown[] = [];
        const emailQueue = defineQueue<{ to: string }>({
            handler: (context, b) => {
                for (const m of b.messages) {
                    seen.push(m.body);
                    m.ack();
                }

                context.log.info("processed");
            },
        });

        const m = message({ to: "x@y.z" });
        await dispatchQueueBatch(batch("email-queue", [m]), { "email-queue": { definition: emailQueue, exportName: "emailQueue" } }, { env: {} });

        expect(seen).toEqual([{ to: "x@y.z" }]);
        expect(m.acked).toBe(true);
    });

    it("throws when no handler is registered for the delivered queue", async () => {
        expect.assertions(1);

        await expect(dispatchQueueBatch(batch("ghost", []), {}, { env: {} })).rejects.toThrow(/no push handler is registered/);
    });

    it("throws the directed error for a prototype-named queue not in the registry (constructor)", async () => {
        expect.assertions(1);

        // `constructor` is a valid wrangler queue name AND a member of Object.prototype.
        // A plain `registry[batch.queue]` would resolve the inherited `Object`, make
        // `entry === undefined` false, and then throw an opaque TypeError while
        // destructuring `entry.definition`. The lookup must treat it as unregistered
        // and raise the directed "no push handler is registered" error instead.
        await expect(dispatchQueueBatch(batch("constructor", []), {}, { env: {} })).rejects.toThrow(/no push handler is registered/);
    });

    it("throws for a pull-declared queue with no handler", async () => {
        expect.assertions(1);

        const pull = defineQueue({ mode: "pull" });

        await expect(dispatchQueueBatch(batch("p", []), { p: { definition: pull, exportName: "p" } }, { env: {} })).rejects.toThrow(/pull consumer/);
    });
});

/** A message double with a caller-chosen id / attempt count for the capture tests. */
const captureMessage = (body: unknown, options: { attempts?: number; id?: string } = {}): MessageLike & { acked: boolean; retried: boolean } => {
    const m = {
        ack: vi.fn<() => void>(() => {
            m.acked = true;
        }),
        acked: false,
        attempts: options.attempts ?? 1,
        body,
        id: options.id ?? "m1",
        retried: false,
        retry: vi.fn<() => void>(() => {
            m.retried = true;
        }),
        timestamp: new Date(0),
    };

    return m;
};

describe("dispatchQueueBatch capture", () => {
    it("records an implicit ack for a clean handler return", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>();
        const queue = defineQueue({ handler: () => {} });
        const m = captureMessage({ ok: true });

        await dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "myQueue" } }, { capture, env: {} });

        expect(capture).toHaveBeenCalledTimes(1);

        const [records] = capture.mock.calls[0] as [{ deadLettered: boolean; exportName: string; outcome: string; queue: string }[]];

        expect(records[0]).toMatchObject({ deadLettered: false, exportName: "myQueue", outcome: "ack" });
    });

    it("records an explicit retry and does not mutate the original message", async () => {
        expect.assertions(4);

        const capture = vi.fn<QueueCaptureSink>();
        let handlerSaw: MessageLike | undefined;
        const queue = defineQueue({
            handler: (_context, b) => {
                [handlerSaw] = b.messages;
                handlerSaw?.retry();
            },
        });
        const m = captureMessage({ ok: false });

        await dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} });

        // The handler sees a WRAPPER, not the original host message, but calling
        // wrapper.retry() delegates to the original's spy.
        expect(handlerSaw).not.toBe(m);
        expect(m.retried).toBe(true);

        const [records] = capture.mock.calls[0] as [{ outcome: string }[]];

        expect(records[0]).toMatchObject({ outcome: "retry" });
        expect(capture).toHaveBeenCalledTimes(1);
    });

    it("records an error and re-throws so workerd still retries the batch", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>();
        const boom = new Error("handler blew up");
        const queue = defineQueue({
            handler: () => {
                throw boom;
            },
        });
        const m = captureMessage({ n: 1 });

        await expect(dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} })).rejects.toBe(boom);

        const [records] = capture.mock.calls[0] as [{ error?: string; outcome: string }[]];

        expect(records[0]).toMatchObject({ error: "handler blew up", outcome: "error" });
    });

    it("re-throws the handler's original error even when it can't be JSON-encoded (cyclic)", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>();
        const cyclic: Record<string, unknown> = {};

        cyclic["self"] = cyclic;

        const queue = defineQueue({
            handler: () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately throwing a non-Error cyclic value to exercise the describe/capture guard
                throw cyclic;
            },
        });
        const m = captureMessage({ n: 1 });

        // Describing the thrown value used to `JSON.stringify` it OUTSIDE the capture
        // guard, so a cyclic throw replaced the handler's error with a serializer
        // TypeError. It must now re-throw the ORIGINAL value and still record `error`.
        await expect(dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} })).rejects.toBe(cyclic);

        const [records] = capture.mock.calls[0] as [{ outcome: string }[]];

        expect(records[0]).toMatchObject({ outcome: "error" });
    });

    it("records error and re-throws even when the handler throws a falsy value (throw undefined)", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>();
        const queue = defineQueue({
            handler: () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercise the falsy-throw path: `throw undefined` reaches the catch with `undefined`, which `handlerError !== undefined` would misread as a clean return
                throw undefined;
            },
        });
        const m = captureMessage({ n: 1 });

        // Dispatch must track "the handler threw" with a dedicated flag, not by
        // inspecting the captured value: an undefined throw still records `error`
        // and re-throws so workerd retries the batch.
        await expect(dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} })).rejects.toBeUndefined();

        const [records] = capture.mock.calls[0] as [{ outcome: string }[]];

        expect(records[0]).toMatchObject({ outcome: "error" });
    });

    it("does not flag deadLettered while a retry still remains (attempts === maxRetries)", async () => {
        expect.assertions(1);

        const capture = vi.fn<QueueCaptureSink>();
        const queue = defineQueue({
            handler: (_context, b) => {
                b.messages[0]?.retry();
            },
            maxRetries: 3,
        });
        // CF semantics: total deliveries = 1 + maxRetries, so `attempts === maxRetries`
        // still has one retry left — this is the off-by-one boundary the fix covers.
        const m = captureMessage({ n: 2 }, { attempts: 3 });

        await dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} });

        const [records] = capture.mock.calls[0] as [{ deadLettered: boolean; outcome: string }[]];

        expect(records[0]).toMatchObject({ deadLettered: false, outcome: "retry" });
    });

    it("flags deadLettered once attempts exceeds maxRetries (retries exhausted)", async () => {
        expect.assertions(1);

        const capture = vi.fn<QueueCaptureSink>();
        const queue = defineQueue({
            handler: (_context, b) => {
                b.messages[0]?.retry();
            },
            maxRetries: 3,
        });
        const m = captureMessage({ n: 2 }, { attempts: 4 });

        await dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} });

        const [records] = capture.mock.calls[0] as [{ deadLettered: boolean; outcome: string }[]];

        expect(records[0]).toMatchObject({ deadLettered: true, outcome: "retry" });
    });

    it("never flags deadLettered for an ack, even past maxRetries", async () => {
        expect.assertions(1);

        const capture = vi.fn<QueueCaptureSink>();
        const queue = defineQueue({
            handler: (_context, b) => {
                b.messages[0]?.ack();
            },
            maxRetries: 3,
        });
        const m = captureMessage({ n: 2 }, { attempts: 4 });

        await dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} });

        const [records] = capture.mock.calls[0] as [{ deadLettered: boolean; outcome: string }[]];

        expect(records[0]).toMatchObject({ deadLettered: false, outcome: "ack" });
    });

    it("fills undecided messages from ackAll / retryAll", async () => {
        expect.assertions(2);

        const ackCapture = vi.fn<QueueCaptureSink>();
        const ackQueue = defineQueue({
            handler: (_context, b) => {
                b.ackAll();
            },
        });

        await dispatchQueueBatch(
            batch("q", [captureMessage(1), captureMessage(2, { id: "m2" })]),
            { q: { definition: ackQueue, exportName: "q" } },
            { capture: ackCapture, env: {} },
        );
        const [ackRecords] = ackCapture.mock.calls[0] as [{ outcome: string }[]];

        expect(ackRecords.every((record) => record.outcome === "ack")).toBe(true);

        const retryCapture = vi.fn<QueueCaptureSink>();
        const retryQueue = defineQueue({
            handler: (_context, b) => {
                b.retryAll();
            },
        });

        await dispatchQueueBatch(
            batch("q", [captureMessage(1), captureMessage(2, { id: "m2" })]),
            { q: { definition: retryQueue, exportName: "q" } },
            { capture: retryCapture, env: {} },
        );
        const [retryRecords] = retryCapture.mock.calls[0] as [{ outcome: string }[]];

        expect(retryRecords.every((record) => record.outcome === "retry")).toBe(true);
    });

    it("swallows a capture-sink rejection so delivery semantics are unchanged", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>(() => Promise.reject(new Error("sink down")));
        const m = captureMessage({ ok: true });
        const queue = defineQueue({ handler: () => {} });

        // The clean-return path resolves despite the sink failing...
        await expect(dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} })).resolves.toBeUndefined();

        // ...and a throwing handler still re-throws (retry preserved) despite the sink failing.
        const boom = new Error("boom");
        const throwing = defineQueue({
            handler: () => {
                throw boom;
            },
        });

        await expect(dispatchQueueBatch(batch("q", [captureMessage(1)]), { q: { definition: throwing, exportName: "q" } }, { capture, env: {} })).rejects.toBe(
            boom,
        );
    });

    it("logs a warning when the capture sink rejects (observability of the observability feature)", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const capture = vi.fn<QueueCaptureSink>(() => Promise.reject(new Error("sink down")));
            const queue = defineQueue({ handler: () => {} });

            // A silently-swallowed sink failure (stale admin token / shard error) used
            // to leave the studio Queues panel empty with zero diagnostic. The bare
            // `catch {}` must now warn (delivery still unaffected — clean return resolves).
            await dispatchQueueBatch(batch("q", [captureMessage(1)]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} });

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]?.[0]).toMatch(/capture sink failed/u);
        } finally {
            warn.mockRestore();
        }
    });
});
