import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageBatchLike } from "@lunora/platform";
import { defineQueue } from "@lunora/queue";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeQueueHost } from "../src/node-queue-host";

describe("createNodeQueueHost", () => {
    let directory: string;

    afterEach(() => {
        if (directory) {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    const freshDatabase = (): Database.Database => {
        directory = mkdtempSync(join(tmpdir(), "lunora-queue-"));

        return new Database(join(directory, "queue.sqlite3"));
    };

    it("round-trips a message from producer to a batched consumer", async () => {
        expect.hasAssertions();

        const emails = defineQueue<{ to: string }>({ handler: () => undefined, maxBatchTimeout: 0 });
        const seen: MessageBatchLike[] = [];
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: (batch) => {
                seen.push(batch);
            },
            queues: { emails },
        });

        await host.bindings.emails.send({ to: "a@example.com" });
        await host.bindings.emails.send({ to: "b@example.com" });

        await expect(host.poll()).resolves.toBe(1);

        expect(seen).toHaveLength(1);
        expect(seen[0]?.queue).toBe("emails");
        expect(seen[0]?.messages.map((message) => (message.body as { to: string }).to)).toStrictEqual(["a@example.com", "b@example.com"]);
        expect(seen[0]?.messages[0]?.attempts).toBe(1);

        // Undecided messages are implicitly acked when the handler returns, so
        // the second poll has nothing left.
        await expect(host.poll()).resolves.toBe(0);
    });

    it("derives the QUEUE_* env and rejects a non-defineQueue value", () => {
        expect.assertions(3);

        const emailQueue = defineQueue({ handler: () => undefined });
        const host = createNodeQueueHost(freshDatabase(), { env: { EXTRA: "kept" }, onBatch: () => undefined, queues: { emailQueue } });

        expect(host.env.EXTRA).toBe("kept");
        expect(host.env.QUEUE_EMAIL_QUEUE).toBe(host.bindings.emailQueue);

        expect(() => createNodeQueueHost(freshDatabase(), { onBatch: () => undefined, queues: { nope: {} as never } })).toThrow(/is not a defineQueue result/);
    });

    it("holds a delayed message back until its delay elapses", async () => {
        expect.hasAssertions();

        const delayed = defineQueue({ handler: () => undefined, maxBatchTimeout: 0 });
        let delivered = 0;
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: (batch) => {
                delivered += batch.messages.length;
            },
            queues: { delayed },
        });

        const now = Date.now();

        await host.bindings.delayed.send("soon", { delaySeconds: 60 });

        await expect(host.poll(now)).resolves.toBe(0);
        expect(delivered).toBe(0);

        await expect(host.poll(now + 60_000)).resolves.toBe(1);
        expect(delivered).toBe(1);
    });

    it("waits for maxBatchTimeout before delivering a partial batch, and fills a full one at once", async () => {
        expect.hasAssertions();

        const batched = defineQueue({ handler: () => undefined, maxBatchSize: 3, maxBatchTimeout: 5 });
        const sizes: number[] = [];
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: (batch) => {
                sizes.push(batch.messages.length);
            },
            queues: { batched },
        });

        const now = Date.now();

        await host.bindings.batched.send("one");

        // One message, batch size 3 — held until the timeout rather than
        // delivered on its own.
        await expect(host.poll(now)).resolves.toBe(0);
        await expect(host.poll(now + 5000)).resolves.toBe(1);
        expect(sizes).toStrictEqual([1]);

        // A full batch does not wait.
        await host.bindings.batched.sendBatch([{ body: "a" }, { body: "b" }, { body: "c" }]);

        await expect(host.poll(now + 5001)).resolves.toBe(1);
        expect(sizes).toStrictEqual([1, 3]);
    });

    it("retries an explicitly retried message and honours its delay", async () => {
        expect.hasAssertions();

        const flaky = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, maxRetries: 5 });
        const attempts: number[] = [];
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: (batch) => {
                attempts.push(batch.messages[0]?.attempts ?? -1);

                if (attempts.length === 1) {
                    batch.messages[0]?.retry({ delaySeconds: 30 });
                }
            },
            queues: { flaky },
        });

        const now = Date.now();

        await host.bindings.flaky.send("payload");

        await expect(host.poll(now)).resolves.toBe(1);

        // Held for the retry delay, then redelivered with attempts incremented.
        await expect(host.poll(now + 1000)).resolves.toBe(0);
        await expect(host.poll(now + 30_000)).resolves.toBe(1);

        expect(attempts).toStrictEqual([1, 2]);
        await expect(host.poll(now + 60_000)).resolves.toBe(0);
    });

    it("retries every undecided message when the handler throws", async () => {
        expect.hasAssertions();

        const crashing = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, maxRetries: 10 });
        let calls = 0;
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: () => {
                calls += 1;

                if (calls === 1) {
                    throw new Error("consumer blew up");
                }
            },
            queues: { crashing },
        });

        const now = Date.now();

        await host.bindings.crashing.send("keep me");

        await expect(host.poll(now)).resolves.toBe(1);
        // A thrown handler must not ack: the message is still there.
        await expect(host.poll(now + 1)).resolves.toBe(1);
        expect(calls).toBe(2);
        await expect(host.poll(now + 2)).resolves.toBe(0);
    });

    it("parks a message that exhausts its retries, and routes it to a dead-letter queue when declared", async () => {
        expect.hasAssertions();

        const parked = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, maxRetries: 2 });
        const routed = defineQueue({ deadLetterQueue: "failures", handler: () => undefined, maxBatchTimeout: 0, maxRetries: 2 });
        const failures = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, name: "failures" });

        const deliveredTo: Record<string, unknown[]> = {};
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: (batch) => {
                deliveredTo[batch.queue] ??= [];

                for (const message of batch.messages) {
                    deliveredTo[batch.queue]?.push(message.body);
                }

                // The dead-letter queue's own consumer succeeds; the two feeder
                // queues fail every attempt.
                if (batch.queue !== "failures") {
                    batch.retryAll();
                }
            },
            queues: { failures, parked, routed },
        });

        await host.bindings.parked.send("doomed");
        await host.bindings.routed.send("also-doomed");

        const now = Date.now();

        // `maxRetries` counts retries AFTER the initial delivery, matching
        // Cloudflare and `dispatchQueueBatch`'s `attempts > maxRetries` — so
        // maxRetries 2 is three deliveries, not two.
        await host.poll(now);
        await host.poll(now + 1);
        await host.poll(now + 2);

        expect(deliveredTo.parked).toStrictEqual(["doomed", "doomed", "doomed"]);
        expect(deliveredTo.routed).toStrictEqual(["also-doomed", "also-doomed", "also-doomed"]);

        // No dead-letter queue declared → parked in place, still inspectable
        // rather than silently dropped.
        const dead = host.deadLetters.list("parked");

        expect(dead).toHaveLength(1);
        expect(dead[0]?.body).toBe("doomed");
        expect(dead[0]?.attempts).toBe(3);

        // Dead-letter queue declared → re-enqueued onto it as a real message, so
        // its consumer receives it the way it receives anything else.
        await expect(host.poll(now + 3)).resolves.toBe(1);
        expect(deliveredTo.failures).toStrictEqual(["also-doomed"]);

        // And it is not parked on its own queue, because it was routed away.
        expect(host.deadLetters.list("routed")).toStrictEqual([]);
    });

    it("redelivers a message whose consumer died mid-handler", async () => {
        expect.hasAssertions();

        directory = mkdtempSync(join(tmpdir(), "lunora-queue-"));

        const path = join(directory, "queue.sqlite3");
        const fragile = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, maxRetries: 5 });
        const now = Date.now();

        // A consumer that claims the batch and never settles it — the shape of a
        // process that died holding the message. `onBatch` never resolves, so
        // this host's `poll` never reaches its settle transaction.
        const dying = new Database(path);
        const dyingHost = createNodeQueueHost(dying, {
            now: () => now,
            onBatch: async () => {
                // Never settles — the batch stays claimed for its visibility window.
                await new Promise<void>(() => {});
            },
            queues: { fragile },
            visibilityTimeoutMs: 10_000,
        });

        await dyingHost.bindings.fragile.send("survive me");

        // Deliberately not awaited: it never settles.
        dyingHost.poll(now).catch(() => undefined);

        const survivor = new Database(path);
        const attempts: number[] = [];
        const survivorHost = createNodeQueueHost(survivor, {
            now: () => now,
            onBatch: (batch) => {
                attempts.push(batch.messages[0]?.attempts ?? -1);
            },
            queues: { fragile },
            visibilityTimeoutMs: 10_000,
        });

        // Still invisible: a redelivery inside the window would mean two
        // consumers holding one message.
        await expect(survivorHost.poll(now + 9999)).resolves.toBe(0);

        // Past the window it comes back, counted as a second delivery — the
        // guarantee the visibility timeout exists for.
        await expect(survivorHost.poll(now + 10_000)).resolves.toBe(1);
        expect(attempts).toStrictEqual([2]);

        dying.close();
        survivor.close();
    });

    it("counts maxRetries as retries after the first delivery", async () => {
        expect.hasAssertions();

        const once = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, maxRetries: 1 });
        let deliveries = 0;
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: (batch) => {
                deliveries += 1;
                batch.retryAll();
            },
            queues: { once },
        });

        const now = Date.now();

        await host.bindings.once.send("try twice");

        await host.poll(now);
        await host.poll(now + 1);
        await host.poll(now + 2);

        // maxRetries 1 = one initial delivery plus one retry. At `>=` this was
        // a single delivery and the retry never happened at all.
        expect(deliveries).toBe(2);
        expect(host.deadLetters.list("once")).toHaveLength(1);
    });

    it("refuses a dead-letter queue that loops or that nothing declares", () => {
        expect.assertions(2);

        const loops = defineQueue({ deadLetterQueue: "loops", handler: () => undefined });
        const nowhere = defineQueue({ deadLetterQueue: "not-declared", handler: () => undefined });

        // Self-reference re-enqueues with `attempts` reset, so it redelivers forever.
        expect(() => createNodeQueueHost(freshDatabase(), { onBatch: () => undefined, queues: { loops } })).toThrow(/its own deadLetterQueue/);

        // An undeclared target writes a row nothing polls and nothing reaps.
        expect(() => createNodeQueueHost(freshDatabase(), { onBatch: () => undefined, queues: { nowhere } })).toThrow(/no declared queue provides/);
    });

    it("clamps a delay beyond the 12-hour ceiling and rejects a mistyped body", async () => {
        expect.hasAssertions();

        const typed = defineQueue({ handler: () => undefined, maxBatchTimeout: 0 });
        const now = Date.now();
        const host = createNodeQueueHost(freshDatabase(), { now: () => now, onBatch: () => undefined, queues: { typed } });

        await host.bindings.typed.send("far future", { delaySeconds: 999_999 });

        // Clamped to 43200s, not held for 999999s.
        await expect(host.poll(now + 43_199_000)).resolves.toBe(0);
        await expect(host.poll(now + 43_200_000)).resolves.toBe(1);

        await expect(host.bindings.typed.send(42, { contentType: "text" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(host.bindings.typed.send("not bytes", { contentType: "bytes" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("round-trips every content type", async () => {
        expect.hasAssertions();

        const typed = defineQueue({ handler: () => undefined, maxBatchTimeout: 0 });
        const bodies: unknown[] = [];
        const host = createNodeQueueHost(freshDatabase(), {
            onBatch: (batch) => {
                for (const message of batch.messages) {
                    bodies.push(message.body);
                }
            },
            queues: { typed },
        });

        await host.bindings.typed.sendBatch([
            { body: { nested: [1, 2] }, contentType: "json" },
            { body: "plain", contentType: "text" },
            { body: new TextEncoder().encode("raw").buffer, contentType: "bytes" },
            // `v8` is the only one that survives a Map — that is the reason it exists.
            { body: new Map([["k", 1]]), contentType: "v8" },
        ]);

        await host.poll();

        expect(bodies[0]).toStrictEqual({ nested: [1, 2] });
        expect(bodies[1]).toBe("plain");
        expect(Buffer.from(bodies[2] as ArrayBuffer).toString("utf8")).toBe("raw");
        expect(bodies[3]).toStrictEqual(new Map([["k", 1]]));
    });

    it("survives a restart and never consumes a pull queue", async () => {
        expect.hasAssertions();

        directory = mkdtempSync(join(tmpdir(), "lunora-queue-"));

        const path = join(directory, "queue.sqlite3");
        const jobs = defineQueue({ handler: () => undefined, maxBatchTimeout: 0 });
        const external = defineQueue({ maxBatchTimeout: 0, mode: "pull" });

        const first = new Database(path);
        const producer = createNodeQueueHost(first, { onBatch: () => undefined, queues: { external, jobs } });

        await producer.bindings.jobs.send("persisted");
        await producer.bindings.external.send("polled elsewhere");
        first.close();

        // A second host over the same file — the message is still there.
        const second = new Database(path);
        const bodies: unknown[] = [];
        const consumer = createNodeQueueHost(second, {
            onBatch: (batch) => {
                for (const message of batch.messages) {
                    bodies.push(message.body);
                }
            },
            queues: { external, jobs },
        });

        await expect(consumer.poll()).resolves.toBe(1);
        // Only the push queue was consumed; the pull queue's message is untouched.
        expect(bodies).toStrictEqual(["persisted"]);

        second.close();
    });
});
