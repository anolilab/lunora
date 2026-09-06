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

    it("gives the handler's ctx.run the consumer invocation's traceparent", async () => {
        expect.assertions(1);

        const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ result: null }, { status: 200 }));

        const q = defineQueue({
            handler: async (context, b) => {
                for (const m of b.messages) {
                    m.ack();
                }

                await context.run({ __lunoraRef: "digests:flush" } as never, undefined);
            },
        });

        await dispatchQueueBatch(
            batch("q", [message({})]),
            { q: { definition: q, exportName: "q" } },
            { env: { LUNORA_ADMIN_TOKEN: "tok", LUNORA_ORIGIN_URL: "https://app.example.com" }, fetchImpl, traceparent },
        );

        // The queue span is the parent of the work the handler dispatches; without
        // this the shard minted a fresh trace per call and one batch's work read as
        // a pile of unrelated root traces.
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect((init.headers as Record<string, string>).traceparent).toBe(traceparent);
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

    it("flags deadLettered once attempts exceeds maxRetries on a queue with a DLQ", async () => {
        expect.assertions(1);

        const capture = vi.fn<QueueCaptureSink>();
        const queue = defineQueue({
            deadLetterQueue: "q-dlq",
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

    it("does not flag deadLettered when the queue declares no dead-letter queue", async () => {
        expect.assertions(1);

        const capture = vi.fn<QueueCaptureSink>();
        // No `deadLetterQueue`: Cloudflare DELETES a message that exhausts
        // maxRetries. Recording it as dead-lettered points an operator at a queue
        // that does not exist and hides the fact that the message is simply gone.
        const queue = defineQueue({
            handler: (_context, b) => {
                b.messages[0]?.retry();
            },
            maxRetries: 3,
        });
        const m = captureMessage({ n: 2 }, { attempts: 4 });

        await dispatchQueueBatch(batch("q", [m]), { q: { definition: queue, exportName: "q" } }, { capture, env: {} });

        const [records] = capture.mock.calls[0] as [{ deadLettered: boolean; outcome: string }[]];

        expect(records[0]).toMatchObject({ deadLettered: false, outcome: "retry" });
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

    it("forwards a message property the MessageLike type doesn't declare (dev/prod parity)", async () => {
        expect.assertions(1);

        // A real workerd Message may carry more than the four `MessageLike`
        // declares. The old capture wrapper rebuilt each message from an
        // object literal listing exactly those four (plus ack/retry), so an
        // undeclared property like this one read `undefined` under capture
        // but its real value with capture off — the bug this test guards.
        const withExtra = { ...captureMessage({ n: 1 }), region: "wnam" };
        let seenRegion: unknown;
        const queue = defineQueue({
            handler: (_context, b) => {
                seenRegion = (b.messages[0] as unknown as { region: string }).region;
            },
        });

        await dispatchQueueBatch(
            batch("q", [withExtra as unknown as MessageLike]),
            { q: { definition: queue, exportName: "q" } },
            { capture: vi.fn<QueueCaptureSink>(), env: {} },
        );

        expect(seenRegion).toBe("wnam");
    });

    it("forwards a batch property MessageBatchLike doesn't declare, alongside messages/queue", async () => {
        expect.assertions(3);

        const rawBatch = batch("q", [captureMessage({ n: 1 })]);
        const withExtra = { ...rawBatch, region: "wnam" };
        let seenRegion: unknown;
        let seenQueue: unknown;
        let seenMessageCount: unknown;
        const queue = defineQueue({
            handler: (_context, b) => {
                seenRegion = (b as unknown as { region: string }).region;
                seenQueue = b.queue;
                seenMessageCount = b.messages.length;
            },
        });

        await dispatchQueueBatch(withExtra, { q: { definition: queue, exportName: "q" } }, { capture: vi.fn<QueueCaptureSink>(), env: {} });

        expect(seenRegion).toBe("wnam");
        expect(seenQueue).toBe("q");
        expect(seenMessageCount).toBe(1);
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

/**
 * Fake `fetch` for `ctx.run`'s dispatch POST: fails with `status`/`code` for
 * the call whose `args.id === failFor`, succeeds for every other call. Models
 * a handler that scopes each `ctx.run` call to one message (§1a's "adjacent
 * read and call" shape), so attribution comes from the explicit `messageId`
 * option the handler passes — never from inference over the request.
 */
const dispatchFetchFailingFor = (failFor: string, status: number, code: string) => async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { args } = JSON.parse((init?.body ?? "{}") as string) as { args?: { id?: string } };

    if (args?.id === failFor) {
        return Response.json({ error: { code, message: `dispatch failed for ${failFor}` } }, { status });
    }

    // The shard's dispatch response always carries a `result` key, so a bare body
    // is not a shape it can produce and the runner now rejects one.
    return Response.json({ result: { ok: true } });
};

/** A handler that scopes its own `ctx.run` call per message via `messageId` — the shape attribution requires. */
const scopedDispatchQueue = defineQueue({
    handler: async (context, b) => {
        for (const m of b.messages) {
            // eslint-disable-next-line no-await-in-loop -- each message's dispatch must be scoped (messageId) before the next starts, mirroring §1a's adjacent read/call shape
            await context.run({ __lunoraRef: "fn" }, { id: m.id }, { messageId: m.id });
        }
    },
});

/**
 * Like {@link scopedDispatchQueue}, but explicitly acks each message right
 * after its own dispatch succeeds — models a handler that commits
 * per-message as it goes, so an earlier message's disposition is already
 * DECIDED (not merely "its `ctx.run` happened to succeed") by the time a
 * later message's dispatch throws.
 */
const scopedDispatchQueueAckingAsItGoes = defineQueue({
    handler: async (context, b) => {
        for (const m of b.messages) {
            // eslint-disable-next-line no-await-in-loop -- see scopedDispatchQueue
            await context.run({ __lunoraRef: "fn" }, { id: m.id }, { messageId: m.id });
            m.ack();
        }
    },
});

/**
 * The shape a real handler writes: `message.run(...)`, with no knowledge of the
 * `{ messageId }` option. The per-message runner pins the id itself, so the
 * failure comes back attributed without the handler doing anything.
 */
// Declares a `deadLetterQueue` so the dead-letter assertions below are about the
// disposition under test and not about whether a DLQ exists at all — an
// exhausted message on a queue WITHOUT one is dropped, never dead-lettered.
const perMessageRunQueue = defineQueue({
    deadLetterQueue: "q-dlq",
    handler: async (_context, b) => {
        for (const m of b.messages) {
            // eslint-disable-next-line no-await-in-loop -- see scopedDispatchQueue
            await m.run({ __lunoraRef: "fn" }, { id: m.id });
        }
    },
});

const DISPATCH_ENV = { LUNORA_ADMIN_TOKEN: "tok", LUNORA_ORIGIN_URL: "https://app.example.com" };

/**
 * A dispatch endpoint that models the shard's replay dedup faithfully: a cache
 * keyed by the body's `id` ALONE — matching `(identity, mutationId)` in
 * `packages/shard-engine/src/ctx-db-idempotency.ts`, which carries no function
 * path, under the single `"system:"` identity every server-initiated dispatch
 * shares. `executed` records only the calls that actually reached a handler, so
 * a colliding id shows up as a MISSING execution rather than an error.
 */
const dedupingDispatchFetch = (): { executed: string[]; fetchImpl: typeof fetch } => {
    const executed: string[] = [];
    const cache = new Map<string, unknown>();

    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const { functionPath, id } = JSON.parse((init?.body ?? "{}") as string) as { functionPath: string; id?: string };

        if (id !== undefined && cache.has(id)) {
            return Response.json(cache.get(id));
        }

        executed.push(functionPath);

        // Wrapped in the `{ result }` envelope the DO always emits.
        const result = { result: { ran: functionPath } };

        if (id !== undefined) {
            cache.set(id, result);
        }

        return Response.json(result);
    }) as typeof fetch;

    return { executed, fetchImpl };
};

describe("dispatchQueueBatch — poison message isolation (deterministic dispatch failure)", () => {
    it("acks the one attributed message on a branded 404 and retries every other UNDECIDED message (never processed, so never lost)", async () => {
        expect.assertions(5);

        const capture = vi.fn<QueueCaptureSink>();
        const m1 = captureMessage({ id: "m1" }, { id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { id: "m2" });
        const m3 = captureMessage({ id: "m3" }, { id: "m3" });

        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2, m3]),
                { q: { definition: scopedDispatchQueue, exportName: "q" } },
                { capture, env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 404, "NOT_FOUND") },
            ),
        ).resolves.toBeUndefined();

        // The handler's loop stops at m2 — it never explicitly acks m1 (its own
        // `ctx.run` merely resolved) and never even reaches m3. Both are
        // undecided, so both must be RETRIED (redelivered), matching what the
        // old whole-batch rethrow would have given them. Only m2, the
        // attributed message, is acked.
        expect(m2.acked).toBe(true);
        expect(m1.retried).toBe(true);
        expect(m3.retried).toBe(true);

        const [records] = capture.mock.calls[0] as [CapturedQueueMessage[]];
        const byId = Object.fromEntries(records.map((record) => [record.messageId, record]));

        expect(byId).toMatchObject({
            m1: { outcome: "retry" },
            m2: { error: expect.stringContaining("dispatch failed for m2"), outcome: "error" },
            m3: { outcome: "retry" },
        });
    });

    it("logs the drop even with NO capture sink configured — the production shape", async () => {
        expect.assertions(4);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const m1 = captureMessage({ id: "m1" }, { id: "m1" });
            const m2 = captureMessage({ id: "m2" }, { id: "m2" });

            // No `capture`: `shouldCaptureQueue(env)` needs an explicit
            // `LUNORA_QUEUE_CAPTURE=1` or a dev-shaped `WORKER_ENV`, so a
            // production deployment passes `undefined` and the capture record
            // that describes the drop is never built. The ack is terminal — no
            // retry, no DLQ — so without a log the message vanishes with no
            // signal anywhere.
            await expect(
                dispatchQueueBatch(
                    batch("q", [m1, m2]),
                    { q: { definition: scopedDispatchQueue, exportName: "q" } },
                    { env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 404, "NOT_FOUND") },
                ),
            ).resolves.toBeUndefined();

            expect(m2.acked).toBe(true);
            expect(error).toHaveBeenCalledTimes(1);
            expect(error.mock.calls[0]?.[0]).toContain("dropped message m2");
        } finally {
            error.mockRestore();
        }
    });

    it("redacts the dropped-message log and names the real disposition", async () => {
        expect.assertions(6);

        // A deterministic 4xx envelope whose INTERNAL-coded message carries the
        // upstream response text VERBATIM. That text is whatever the upstream
        // wrote — here a bearer token — and the drop log is a Workers log line,
        // so it must go through the same redaction every other error-to-output
        // path uses. (A non-envelope body is no longer deterministic, so it
        // would be retried rather than dropped and never reach this log.)
        const secret = "Bearer sk-live-4f9c1a";
        const leakyFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            const { args } = JSON.parse((init?.body ?? "{}") as string) as { args?: { id?: string } };

            if (args?.id === "m2") {
                return Response.json({ error: { code: "INTERNAL", message: `upstream rejected: authorization=${secret}` } }, { status: 400 });
            }

            // The shard's dispatch response always carries a `result` key, so a bare body
            // is not a shape it can produce and the runner now rejects one.
            return Response.json({ result: { ok: true } });
        }) as typeof fetch;

        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const m1 = captureMessage({ id: "m1" }, { id: "m1" });
            const m2 = captureMessage({ id: "m2" }, { id: "m2" });

            await expect(
                dispatchQueueBatch(
                    batch("q", [m1, m2]),
                    { q: { definition: scopedDispatchQueue, exportName: "q" } },
                    { env: DISPATCH_ENV, fetchImpl: leakyFetch },
                ),
            ).resolves.toBeUndefined();

            expect(m2.acked).toBe(true);
            expect(error).toHaveBeenCalledTimes(1);

            const logged = (error.mock.calls[0] ?? []).map((part) => (part instanceof Error ? part.message : String(part))).join(" ");

            expect(logged).toContain("dropped message m2");
            // Redacted to its code — the raw upstream body never reaches the log.
            expect(logged).not.toContain(secret);
            // And the disposition is named exactly: a deterministic dispatch
            // failure, NOT an exhausted retry budget. An operator told the wrong
            // one goes looking in a dead-letter queue this message never enters.
            expect(logged).toContain("deterministic 400 (INTERNAL");
        } finally {
            error.mockRestore();
        }
    });

    it("keeps an explicit ack the handler already made and only retries the genuinely undecided message", async () => {
        expect.assertions(5);

        const capture = vi.fn<QueueCaptureSink>();
        const m1 = captureMessage({ id: "m1" }, { id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { id: "m2" });
        const m3 = captureMessage({ id: "m3" }, { id: "m3" });

        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2, m3]),
                { q: { definition: scopedDispatchQueueAckingAsItGoes, exportName: "q" } },
                { capture, env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 404, "NOT_FOUND") },
            ),
        ).resolves.toBeUndefined();

        // m1 was explicitly acked by the handler before m2's dispatch threw —
        // that decision stands. m2 is the attributed poison message. m3 was
        // never reached, so it must be retried, not silently acked.
        expect(m1.acked).toBe(true);
        expect(m2.acked).toBe(true);
        expect(m3.retried).toBe(true);

        const [records] = capture.mock.calls[0] as [CapturedQueueMessage[]];
        const byId = Object.fromEntries(records.map((record) => [record.messageId, record]));

        expect(byId).toMatchObject({
            m1: { outcome: "ack" },
            m2: { outcome: "error" },
            m3: { outcome: "retry" },
        });
    });

    it("still rethrows the whole batch for a non-deterministic (500) failure — unchanged", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>();
        const m1 = captureMessage({ id: "m1" }, { id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { id: "m2" });

        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2]),
                { q: { definition: scopedDispatchQueue, exportName: "q" } },
                { capture, env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 500, "INTERNAL") },
            ),
        ).rejects.toThrow(/dispatch failed for m2/);

        expect(m2.acked).toBe(false);
    });

    it("acks the attributed message for an RLS 403 — a per-message verdict is still poison", async () => {
        expect.assertions(3);

        const m1 = captureMessage({ id: "m1" }, { id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { id: "m2" });

        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2]),
                { q: { definition: scopedDispatchQueue, exportName: "q" } },
                { env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 403, "FORBIDDEN") },
            ),
        ).resolves.toBeUndefined();

        expect(m2.acked).toBe(true);
        expect(m1.retried).toBe(true);
    });

    it("rethrows the whole batch for a DISPATCH_UNAUTHENTICATED 403 — the worker is misconfigured, not the message", async () => {
        expect.assertions(3);

        const m1 = captureMessage({ id: "m1" }, { id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { id: "m2" });

        // Same status and same envelope shape as the RLS 403 above; only the
        // `code` separates them. A wrong/rotated `LUNORA_ADMIN_TOKEN` fails every
        // message identically, so acking the attributed one would drop the next
        // message on every redelivery until the queue drained.
        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2]),
                { q: { definition: scopedDispatchQueue, exportName: "q" } },
                { env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 403, "DISPATCH_UNAUTHENTICATED") },
            ),
        ).rejects.toThrow(/dispatch failed for m2/);

        expect(m2.acked).toBe(false);
        expect(m1.acked).toBe(false);
    });

    it("still rethrows the whole batch for a 429 (transient — guards against widening the deterministic set)", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>();
        const m1 = captureMessage({ id: "m1" }, { id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { id: "m2" });

        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2]),
                { q: { definition: scopedDispatchQueue, exportName: "q" } },
                { capture, env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 429, "RATE_LIMITED") },
            ),
        ).rejects.toThrow(/dispatch failed for m2/);

        expect(m2.acked).toBe(false);
    });

    it("isolates the poison message for a handler that only uses `message.run` — no capture sink, no messageId option", async () => {
        expect.assertions(4);

        const m1 = captureMessage({ id: "m1" }, { id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { id: "m2" });
        const m3 = captureMessage({ id: "m3" }, { id: "m3" });

        // The public path a real app takes: the handler calls `message.run(...)`
        // and knows nothing about `{ messageId }`, and production runs with NO
        // capture sink. Attribution used to require both, so this batch
        // dead-lettered wholesale — one bad message retrying all its siblings.
        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2, m3]),
                { q: { definition: perMessageRunQueue, exportName: "q" } },
                { env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 404, "NOT_FOUND") },
            ),
        ).resolves.toBeUndefined();

        expect(m2.acked).toBe(true);
        expect(m1.retried).toBe(true);
        expect(m3.retried).toBe(true);
    });

    it("records the attributed message's own disposition (error, never dead-lettered) alongside its siblings' retries", async () => {
        expect.assertions(2);

        const capture = vi.fn<QueueCaptureSink>();
        // `attempts: 9` is past `maxRetries: 3`: a retried sibling at that point
        // IS dead-lettered, but the attributed message was acked, so the broker
        // never redelivers it and it must not be flagged.
        const m1 = captureMessage({ id: "m1" }, { attempts: 9, id: "m1" });
        const m2 = captureMessage({ id: "m2" }, { attempts: 9, id: "m2" });

        await expect(
            dispatchQueueBatch(
                batch("q", [m1, m2]),
                { q: { definition: perMessageRunQueue, exportName: "q" } },
                { capture, env: DISPATCH_ENV, fetchImpl: dispatchFetchFailingFor("m2", 422, "INVALID_ARGUMENT") },
            ),
        ).resolves.toBeUndefined();

        const [records] = capture.mock.calls[0] as [CapturedQueueMessage[]];
        const byId = Object.fromEntries(records.map((record) => [record.messageId, record]));

        expect(byId).toStrictEqual({
            m1: expect.objectContaining({ deadLettered: true, error: undefined, outcome: "retry" }),
            m2: expect.objectContaining({ deadLettered: false, error: expect.stringContaining("dispatch failed for m2"), outcome: "error" }),
        });
    });

    it("executes BOTH of a handler's `message.run` calls — one pinned id for every call would collide them in the shard's dedup table", async () => {
        expect.assertions(3);

        const { executed, fetchImpl } = dedupingDispatchFetch();

        // The exact shape the shard sees: its dedup table is keyed
        // `(identity, mutationId)` with no function path, and every
        // server-initiated dispatch shares one identity — so if both calls
        // carried the same id, `sendReceipt` would silently return
        // `chargeCustomer`'s cached result and never run.
        const queue = defineQueue({
            handler: async (_context, b) => {
                const m = b.messages[0]!;

                await m.run({ __lunoraRef: "billing:chargeCustomer" });
                await m.run({ __lunoraRef: "billing:sendReceipt" });
            },
        });

        await expect(
            dispatchQueueBatch(
                batch("q", [captureMessage({ id: "m1" }, { id: "m1" })]),
                { q: { definition: queue, exportName: "q" } },
                { env: DISPATCH_ENV, fetchImpl },
            ),
        ).resolves.toBeUndefined();

        expect(executed).toStrictEqual(["billing:chargeCustomer", "billing:sendReceipt"]);
        // Distinct dedup ids are what keeps them apart.
        expect(new Set(executed).size).toBe(2);
    });

    it("dedups each call to its own first-run result when the same message is redelivered — nothing double-applied, nothing skipped", async () => {
        expect.assertions(4);

        const { executed, fetchImpl } = dedupingDispatchFetch();

        // The at-least-once shape: both calls succeed, then the handler throws,
        // so the broker redelivers and the handler replays from the start.
        const queue = defineQueue({
            handler: async (_context, b) => {
                const m = b.messages[0]!;

                await m.run({ __lunoraRef: "billing:chargeCustomer" });
                await m.run({ __lunoraRef: "billing:sendReceipt" });
                throw new Error("batch failed after both calls");
            },
        });
        const registry = { q: { definition: queue, exportName: "q" } };

        await expect(dispatchQueueBatch(batch("q", [captureMessage({ id: "m1" }, { id: "m1" })]), registry, { env: DISPATCH_ENV, fetchImpl })).rejects.toThrow(
            /batch failed/,
        );

        expect(executed).toStrictEqual(["billing:chargeCustomer", "billing:sendReceipt"]);

        // Redelivery: same message id, higher attempt count. The counter
        // restarts, so each call reproduces its own id and hits its own cached
        // result — neither charge nor receipt is applied twice.
        await expect(
            dispatchQueueBatch(batch("q", [captureMessage({ id: "m1" }, { attempts: 2, id: "m1" })]), registry, { env: DISPATCH_ENV, fetchImpl }),
        ).rejects.toThrow(/batch failed/);

        expect(executed).toStrictEqual(["billing:chargeCustomer", "billing:sendReceipt"]);
    });

    it("still rethrows when the handler throws undefined (not a LunoraError, so never attributable)", async () => {
        expect.assertions(1);

        const capture = vi.fn<QueueCaptureSink>();
        const queue = defineQueue({
            handler: () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercise the falsy-throw path: a non-error throw can never satisfy isDeterministicDispatchFailure, so it must stay on the whole-batch rethrow
                throw undefined;
            },
        });

        await expect(
            dispatchQueueBatch(
                batch("q", [captureMessage({ id: "m1" }, { id: "m1" })]),
                { q: { definition: queue, exportName: "q" } },
                { capture, env: DISPATCH_ENV },
            ),
        ).rejects.toBeUndefined();
    });
});
