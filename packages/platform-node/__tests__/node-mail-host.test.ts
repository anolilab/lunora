import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MailTransport, SendPayload } from "@lunora/mail";
import { MailSendError } from "@lunora/mail";
import { defineQueue } from "@lunora/queue";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeMailHost } from "../src/node-mail-host";
import { createNodePlatform } from "../src/node-platform";

const PRODUCTION = { MAIL_FROM: "Acme <noreply@acme.test>", NODE_ENV: "production" };

/** A transport whose first send waits for `release()`, announcing through `entered` that it has started; later sends succeed. */
const blockingTransport = (): { entered: Promise<void>; release: () => void; sent: SendPayload[]; transport: MailTransport } => {
    const sent: SendPayload[] = [];
    let announce: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
        announce = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });

    return {
        entered,
        release: () => {
            release();
        },
        sent,
        transport: {
            send: async (payload) => {
                sent.push(payload);

                if (sent.length === 1) {
                    announce();
                    await released;
                }

                return { id: `msg-${String(sent.length)}` };
            },
        },
    };
};

/** The JSON a `[@lunora/platform-node]` log line carries. */
const logged = (line: unknown): Record<string, unknown> => JSON.parse(String(line).replace("[@lunora/platform-node] ", "")) as Record<string, unknown>;

/** A transport that answers each send with the next scripted outcome, and records what it was handed. */
const scriptedTransport = (outcomes: ReadonlyArray<Error | "ok">): MailTransport & { sent: SendPayload[] } => {
    const sent: SendPayload[] = [];
    let call = 0;

    return {
        send: async (payload) => {
            sent.push(payload);

            const outcome = outcomes[Math.min(call, outcomes.length - 1)];

            call += 1;

            if (outcome instanceof Error) {
                throw outcome;
            }

            return { id: `msg-${String(call)}` };
        },
        sent,
    };
};

describe(createNodeMailHost, () => {
    let directory: string | undefined;

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();

        if (directory !== undefined) {
            rmSync(directory, { force: true, recursive: true });
            directory = undefined;
        }
    });

    const freshDatabase = (): Database.Database => {
        directory = mkdtempSync(join(tmpdir(), "lunora-mail-"));

        return new Database(join(directory, "mail.sqlite3"));
    };

    /** The host clock, seeded from the real one because `consumeQueuedSend` ages a message against `Date.now()`. */
    const startClock = (): { advance: (ms: number) => void; now: () => number } => {
        let current = Date.now();

        return {
            advance: (ms) => {
                current += ms;
            },
            now: () => current,
        };
    };

    it("enqueues a queued send durably and hands it to the transport on poll", async () => {
        expect.assertions(5);

        const database = freshDatabase();
        const clock = startClock();
        const transport = scriptedTransport(["ok"]);
        const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });

        await expect(mail.mailer.queue({ subject: "Welcome", text: "Hi", to: "ada@example.com" })).resolves.toStrictEqual({ queued: true });

        // Queued, not sent: the row is on disk and nothing reached the transport yet.
        expect(database.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages WHERE queue = 'lunora-mail'").get()).toStrictEqual({ n: 1 });
        expect(transport.sent).toStrictEqual([]);

        await mail.poll();

        expect(transport.sent).toMatchObject([{ from: "Acme <noreply@acme.test>", subject: "Welcome", text: "Hi", to: "ada@example.com" }]);
        expect(database.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages").get()).toStrictEqual({ n: 0 });
    });

    it("retries a failed send on the next poll and logs the failure", async () => {
        expect.assertions(4);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const clock = startClock();
        const transport = scriptedTransport([new MailSendError({ message: "provider is down", retryable: true }), "ok"]);
        const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

        await mail.mailer.queue({ subject: "Reset", text: "Code 1234", to: "ada@example.com" });
        await mail.poll();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(warn.mock.calls[0]?.[0]).replace("[@lunora/platform-node] ", ""))).toMatchObject({
            attempts: 1,
            event: "lunora.mail.send_retry",
            queue: "lunora-mail",
        });

        await mail.poll();

        // Same message, delivered on its second attempt, and nothing left to send.
        expect(transport.sent.map((payload) => payload.subject)).toStrictEqual(["Reset", "Reset"]);
        await expect(mail.poll()).resolves.toBe(0);
    });

    it("parks a send that keeps failing once the queue's retries are spent", async () => {
        expect.assertions(3);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const clock = startClock();
        const transport = scriptedTransport([new Error("connection refused")]);
        const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

        await mail.mailer.queue({ subject: "Receipt", text: "Thanks", to: "ada@example.com" });

        // The first delivery plus the queue host's default three retries.
        for (let delivery = 0; delivery < 4; delivery += 1) {
            // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
            await mail.poll();
        }

        expect(transport.sent).toHaveLength(4);
        expect(mail.deadLetters.list()).toMatchObject([{ attempts: 4, body: { subject: "Receipt" } }]);
        await expect(mail.poll()).resolves.toBe(0);
    });

    it("drops and logs a send the provider refused, rather than retrying it", async () => {
        expect.assertions(3);

        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const clock = startClock();
        const transport = scriptedTransport([new MailSendError({ message: "invalid recipient", retryable: false })]);
        const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

        await mail.mailer.queue({ subject: "Hello", text: "Hi", to: "ada@example.com" });
        await mail.poll();
        await mail.poll();

        expect(transport.sent).toHaveLength(1);
        expect(String(error.mock.calls[0]?.[0])).toContain('"event":"lunora.mail.send_refused"');
        expect(mail.deadLetters.list()).toStrictEqual([]);
    });

    it("waits out the retry delay before trying an outcome-unknown send again", async () => {
        expect.assertions(2);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const clock = startClock();
        const transport = scriptedTransport([new MailSendError({ message: "timed out", outcomeUnknown: true, retryable: false }), "ok"]);
        // The Resend transport's flag: a repeat carrying the same key is dropped, so the unknown outcome may be retried.
        const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport: { ...transport, dedupesOnIdempotencyKey: true } });

        await mail.mailer.queue({ subject: "Code", text: "1234", to: "ada@example.com" });
        await mail.poll();
        clock.advance(179_000);
        await mail.poll();

        expect(transport.sent).toHaveLength(1);

        clock.advance(1000);
        await mail.poll();

        expect(transport.sent).toHaveLength(2);
    });

    it.each([
        ["MAIL_FROM is unset", { NODE_ENV: "production" }, /MAIL_FROM/u],
        ["nothing can deliver", PRODUCTION, /RESEND_API_KEY/u],
    ])("refuses construction when %s", (_label, env, message) => {
        expect.assertions(1);

        expect(() => createNodeMailHost(freshDatabase(), { env })).toThrow(message);
    });

    it("builds a Resend mailer from RESEND_API_KEY when no transport is given", () => {
        expect.assertions(1);

        expect(() => createNodeMailHost(freshDatabase(), { env: { ...PRODUCTION, RESEND_API_KEY: "re_test" } })).not.toThrow();
    });

    it("is composed by createNodePlatform({ mail }) over the shard's database", async () => {
        expect.assertions(3);

        directory = mkdtempSync(join(tmpdir(), "lunora-mail-platform-"));

        const clock = startClock();
        const transport = scriptedTransport(["ok"]);

        using platform = createNodePlatform({ mail: { env: PRODUCTION, now: clock.now, transport }, path: join(directory, "shard.sqlite3") });

        using bare = createNodePlatform({ path: join(directory, "bare.sqlite3") });

        expect(bare.mail).toBeUndefined();

        await platform.mail?.mailer.queue({ subject: "Invite", text: "Join", to: "ada@example.com" });

        await expect(platform.mail?.poll()).resolves.toBe(1);
        expect(transport.sent.map((payload) => payload.subject)).toStrictEqual(["Invite"]);
    });

    it("refuses an app queue under the mail queue's name, whose rows both hosts would claim", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-mail-clash-"));

        const outbox = defineQueue({ handler: () => undefined, name: "lunora-mail" });

        expect(() =>
            createNodePlatform({
                mail: { env: PRODUCTION, transport: scriptedTransport(["ok"]) },
                onQueueBatch: () => undefined,
                path: join(directory ?? "", "shard.sqlite3"),
                queues: { outbox },
            }),
        ).toThrow(/"lunora-mail"/u);
    });

    describe("delivery semantics", () => {
        it("keeps a claimed send hidden from an overlapping poll while it is still being sent", async () => {
            expect.assertions(2);

            const clock = startClock();
            const gate = blockingTransport();
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport: gate.transport });

            await mail.mailer.queue({ subject: "Code", text: "1234", to: "ada@example.com" });

            const first = mail.poll();

            await gate.entered;
            // Past the queue host's default 30 s lease, inside the 60 s a send may take.
            clock.advance(45_000);

            await expect(mail.poll()).resolves.toBe(0);

            gate.release();
            await first;

            expect(gate.sent).toHaveLength(1);
        });

        it("acks a second enqueue of an idempotency key that was already sent, without sending it again", async () => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "welcome-ada", subject: "Welcome", text: "Hi", to: "ada@example.com" });
            await mail.poll();
            await mail.mailer.queue({ idempotencyKey: "welcome-ada", subject: "Welcome", text: "Hi", to: "ada@example.com" });
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
            expect(database.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages").get()).toStrictEqual({ n: 0 });
        });

        it("refuses a requeued dead letter that may have landed once the provider's dedupe window has passed", async () => {
            expect.assertions(4);

            // Only Date is faked: `consumeQueuedSend` ages a message against Date.now(), and the
            // replay has to happen a day after the send. The mailer's deadline timer stays real.
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));
            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const unknown = new MailSendError({ message: "socket hang up", outcomeUnknown: true, retryable: false });
            const transport = scriptedTransport([unknown, unknown, unknown, unknown, "ok"]);
            // Resend's flag: a repeat of the key is dropped, so each outcome-unknown send is retried.
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, transport: { ...transport, dedupesOnIdempotencyKey: true } });

            await mail.mailer.queue({ subject: "Reset", text: "Link", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
                vi.setSystemTime(Date.now() + 180_000);
            }

            const [parked] = mail.deadLetters.list();

            vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);

            expect(mail.deadLetters.requeue(parked?.id ?? "")).toBe(true);

            await mail.poll();

            // Any of the four may have been delivered, and Resend no longer drops a repeat of the key.
            expect(transport.sent).toHaveLength(4);
            expect(mail.deadLetters.list()).toStrictEqual([]);
            expect(error.mock.calls.map(([line]) => logged(line).event)).toContain("lunora.mail.send_outcome_unknown");
        });

        it("will not requeue another queue's dead letter through the mail host", async () => {
            expect.assertions(2);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-requeue-"));

            const jobs = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, maxRetries: 0 });

            using platform = createNodePlatform({
                mail: { env: PRODUCTION, transport: scriptedTransport(["ok"]) },
                onQueueBatch: () => {
                    throw new Error("job failed");
                },
                path: join(directory, "shard.sqlite3"),
                queues: { jobs },
            });

            await platform.queues?.bindings.jobs.send({ n: 1 });
            await platform.queues?.poll();

            const [parked] = platform.queues?.deadLetters.list("jobs") ?? [];

            expect(platform.mail?.deadLetters.requeue(parked?.id ?? "")).toBe(false);
            expect(platform.queues?.deadLetters.list("jobs")).toHaveLength(1);
        });

        it("drains a mail poll in flight before the platform can close", async () => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-drain-"));

            const path = join(directory, "shard.sqlite3");
            const gate = blockingTransport();
            const platform = createNodePlatform({ mail: { env: PRODUCTION, transport: gate.transport }, path });

            await platform.mail?.mailer.queue({ subject: "Bye", text: "Shutting down", to: "ada@example.com" });

            const polling = platform.mail?.poll();

            await gate.entered;

            const reader = new Database(path, { readonly: true });
            let rowsWhenDrained: unknown;
            const drained = (async () => {
                await platform.drain();
                rowsWhenDrained = reader.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages").get();
            })();

            gate.release();
            await drained;
            await polling;
            reader.close();
            platform.close();

            // Settled (acked) before drain() resolved, so close() could not cut it off.
            expect(rowsWhenDrained).toStrictEqual({ n: 0 });
        });

        it("logs a transport error's own message and stack under the mailer's generic wrapper", async () => {
            expect.assertions(2);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const transport = scriptedTransport([new Error("ECONNREFUSED smtp.acme.test:587"), "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: startClock().now, transport });

            await mail.mailer.queue({ subject: "Hi", text: "Hi", to: "ada@example.com" });
            await mail.poll();

            const { error } = logged(warn.mock.calls[0]?.[0]) as { error: { cause?: { message: string; stack?: string } } };

            expect(error.cause?.message).toBe("ECONNREFUSED smtp.acme.test:587");
            expect(error.cause?.stack).toContain("ECONNREFUSED smtp.acme.test:587");
        });

        it("logs the delivery that parks a send as an error, not as another retry", async () => {
            expect.assertions(2);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const transport = scriptedTransport([new Error("connection refused")]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: startClock().now, transport });

            await mail.mailer.queue({ subject: "Receipt", text: "Thanks", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
            }

            expect(warn.mock.calls.map(([line]) => logged(line).attempts)).toStrictEqual([1, 2, 3]);
            expect(error.mock.calls.map(([line]) => logged(line))).toMatchObject([{ attempts: 4, event: "lunora.mail.send_dead_lettered" }]);
        });

        it("sends through the transport when RESEND_API_KEY is also set", async () => {
            expect.assertions(1);

            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: { ...PRODUCTION, RESEND_API_KEY: "re_test" }, now: startClock().now, transport });

            await mail.mailer.queue({ subject: "Hi", text: "Hi", to: "ada@example.com" });
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
        });
    });
});
