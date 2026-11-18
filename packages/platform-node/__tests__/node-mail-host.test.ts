import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MailTransport, SendPayload } from "@lunora/mail";
import { MailSendError, shouldCaptureMail } from "@lunora/mail";
import { defineQueue } from "@lunora/queue";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeMailHost } from "../src/node-mail-host";
import { createNodePlatform } from "../src/node-platform";
import { createNodeQueueHost } from "../src/node-queue-host";

const PRODUCTION = { MAIL_FROM: "Acme <noreply@acme.test>", NODE_ENV: "production" };

/** The mail queue's lease: 10 sends × (60 s deadline + 40 s of ledger calls) + 60 s. */
const MAIL_LEASE_MS = 10 * (60_000 + 40_000) + 60_000;

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

    it("is composed by createNodePlatform({ mail }) on a database file of its own", async () => {
        expect.assertions(4);

        directory = mkdtempSync(join(tmpdir(), "lunora-mail-platform-"));

        const clock = startClock();
        const transport = scriptedTransport(["ok"]);
        const shardPath = join(directory, "shard.sqlite3");
        const mailPath = join(directory, "mail.sqlite3");

        using platform = createNodePlatform({ mail: { env: PRODUCTION, now: clock.now, path: mailPath, transport }, path: shardPath });

        using bare = createNodePlatform({ path: join(directory, "bare.sqlite3") });

        expect(bare.mail).toBeUndefined();

        await platform.mail?.mailer.queue({ subject: "Invite", text: "Join", to: "ada@example.com" });

        await expect(platform.mail?.poll()).resolves.toBe(1);
        expect(transport.sent.map((payload) => payload.subject)).toStrictEqual(["Invite"]);

        const shardTables = new Database(shardPath, { readonly: true });

        // Nothing of mail's lives in the shard's file, which its transactions hold.
        expect(shardTables.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_lunora_mail%'").all()).toStrictEqual([]);

        shardTables.close();
    });

    it("lets an app queue named lunora-mail coexist with mail, whose queue lives in its own file", async () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-mail-names-"));

        const outbox = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, name: "lunora-mail" });
        const batches: string[] = [];
        const transport = scriptedTransport(["ok"]);

        using platform = createNodePlatform({
            mail: { env: PRODUCTION, now: startClock().now, path: join(directory, "mail.sqlite3"), transport },
            onQueueBatch: (batch) => {
                batches.push(batch.queue);
            },
            path: join(directory, "shard.sqlite3"),
            queues: { outbox },
        });

        await platform.queues?.bindings.outbox.send({ n: 1 });
        await platform.mail?.mailer.queue({ subject: "Hi", text: "Hi", to: "ada@example.com" });
        await platform.queues?.poll();
        await platform.mail?.poll();

        // Each host consumed only its own row.
        expect(batches).toStrictEqual(["lunora-mail"]);
        expect(transport.sent).toHaveLength(1);
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
                mail: { env: PRODUCTION, path: join(directory, "mail.sqlite3"), transport: scriptedTransport(["ok"]) },
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

            const mailPath = join(directory, "mail.sqlite3");
            const gate = blockingTransport();
            const platform = createNodePlatform({
                mail: { env: PRODUCTION, path: mailPath, transport: gate.transport },
                path: join(directory, "shard.sqlite3"),
            });

            await platform.mail?.mailer.queue({ subject: "Bye", text: "Shutting down", to: "ada@example.com" });

            const polling = platform.mail?.poll();

            await gate.entered;

            const reader = new Database(mailPath, { readonly: true });
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

    describe("second review", () => {
        const countRows = (database: Database.Database, table: string): unknown => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();

        it("sends one copy when overlapping polls claim two rows with the same idempotency key", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const clock = startClock();
            const gate = blockingTransport();
            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport: gate.transport });

            await mail.mailer.queue({ idempotencyKey: "otp-ada", subject: "Code", text: "1234", to: "ada@example.com" });

            const first = mail.poll();

            await gate.entered;
            await mail.mailer.queue({ idempotencyKey: "otp-ada", subject: "Code", text: "1234", to: "ada@example.com" });
            // Claims the second row while the first send of the same key is still in flight.
            await mail.poll();

            gate.release();
            await first;
            clock.advance(180_000);
            // The retried duplicate now finds the key in the ledger and is acked unsent.
            await mail.poll();

            expect(gate.sent).toHaveLength(1);
            expect(countRows(database, "_lunora_queue_messages")).toStrictEqual({ n: 0 });
        });

        it("measures the dedupe window on the host clock when it runs behind wall time", async () => {
            expect.assertions(1);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            // Two days behind the wall clock: the send is three minutes old on the host clock.
            const clock = startClock();

            clock.advance(-48 * 60 * 60 * 1000);

            const unknown = new MailSendError({ message: "socket hang up", outcomeUnknown: true, retryable: false });
            const transport = scriptedTransport([unknown, "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport: { ...transport, dedupesOnIdempotencyKey: true } });

            await mail.mailer.queue({ subject: "Code", text: "1234", to: "ada@example.com" });
            await mail.poll();
            clock.advance(180_000);
            await mail.poll();

            expect(transport.sent).toHaveLength(2);
        });

        it("refuses a late replay when only the host clock has moved past the dedupe window", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const clock = startClock();
            const unknown = new MailSendError({ message: "socket hang up", outcomeUnknown: true, retryable: false });
            const transport = scriptedTransport([unknown, unknown, unknown, unknown, "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport: { ...transport, dedupesOnIdempotencyKey: true } });

            await mail.mailer.queue({ subject: "Reset", text: "Link", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
                clock.advance(180_000);
            }

            const [parked] = mail.deadLetters.list();

            clock.advance(25 * 60 * 60 * 1000);

            expect(mail.deadLetters.requeue(parked?.id ?? "")).toBe(true);

            await mail.poll();

            expect(transport.sent).toHaveLength(4);
        });

        it("prunes the sent ledger through an index, at most once a minute", async () => {
            expect.assertions(3);

            const clock = startClock();
            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport: scriptedTransport(["ok"]) });
            const plan = database.prepare<[number], { detail: string }>("EXPLAIN QUERY PLAN DELETE FROM _lunora_mail_sent WHERE expires_at <= ?").all(0);

            expect(plan.map((row) => row.detail).join(" ")).toContain("_lunora_mail_sent_expires");

            const sendOne = async (subject: string): Promise<void> => {
                await mail.mailer.queue({ subject, text: "Hi", to: "ada@example.com" });
                await mail.poll();
            };

            await sendOne("First");
            database.prepare("INSERT INTO _lunora_mail_sent (key, value, expires_at) VALUES ('stale', 'x', ?)").run(clock.now() - 1);
            clock.advance(1000);
            await sendOne("Second");

            // Pruned a second ago, so this write leaves the expired row for the next minute.
            expect(database.prepare("SELECT key FROM _lunora_mail_sent WHERE key = 'stale'").get()).toStrictEqual({ key: "stale" });

            clock.advance(60_000);
            await sendOne("Third");

            expect(database.prepare("SELECT key FROM _lunora_mail_sent WHERE key = 'stale'").get()).toBeUndefined();
        });

        it("keeps an app queue host on the same connection from resetting a parked mail send", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            // createNodeMailHost used on its own, sharing one connection with the app's queues.
            const database = freshDatabase();
            const app = createNodeQueueHost(database, {
                onBatch: () => undefined,
                queues: { jobs: defineQueue({ handler: () => undefined, maxBatchTimeout: 0 }) },
            });
            const mail = createNodeMailHost(database, {
                env: PRODUCTION,
                now: startClock().now,
                transport: scriptedTransport([new Error("connection refused")]),
            });

            await mail.mailer.queue({ subject: "Reset", text: "Link", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
            }

            const [parked] = mail.deadLetters.list();

            // The app host would reset its attempts to 0, which skips the late-redelivery check.
            expect(app.deadLetters.requeue(parked?.id ?? "")).toBe(false);
            expect(mail.deadLetters.list()).toMatchObject([{ attempts: 4 }]);
        });
    });

    describe("third review", () => {
        it("refuses, loudly, a reused idempotency key whose content differs", async () => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "invite-42", subject: "Invite", text: "Join team A", to: "ada@example.com" });
            await mail.poll();

            // Refused at enqueue, where the producer can act on it, never acked later as already sent.
            await expect(mail.mailer.queue({ idempotencyKey: "invite-42", subject: "Invite", text: "Join team B", to: "bob@example.com" })).rejects.toThrow(
                /already queued with different content/u,
            );

            await mail.poll();

            expect(transport.sent.map((payload) => payload.to)).toStrictEqual(["ada@example.com"]);
        });

        it("records a key as sent only once the transport has confirmed the send", async () => {
            expect.assertions(3);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const clock = startClock();
            const database = freshDatabase();
            const transport = scriptedTransport([new Error("connection refused"), "ok"]);
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });
            const sentRecord = (): unknown => database.prepare("SELECT value FROM _lunora_mail_sent WHERE key = 'receipt-7'").get();

            await mail.mailer.queue({ idempotencyKey: "receipt-7", subject: "Receipt", text: "Thanks", to: "ada@example.com" });
            await mail.poll();

            // The failed attempt left marks under their own keys, never the key itself.
            expect(sentRecord()).toBeUndefined();

            await mail.poll();

            expect(transport.sent).toHaveLength(2);
            expect(sentRecord()).toStrictEqual({ value: "msg-2" });
        });

        it("cannot collide an attempt mark with a real idempotency key", async () => {
            expect.assertions(2);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            // The shape of an attempt mark. Keys are visible ASCII only, so no producer can mint it, and a
            // raw body carrying it is refused before the ledger is read, rather than acked as sent.
            await mail.mailer.queue({ idempotencyKey: "foo", subject: "Hi", text: "Hi", to: "ada@example.com" });
            await mail.queue.send({ idempotencyKey: "sending 1 foo", subject: "Hi", text: "Hi", to: "bob@example.com" });
            await mail.poll();

            expect(transport.sent.map((payload) => payload.to)).toStrictEqual(["ada@example.com"]);
            expect(logged(error.mock.calls[0]?.[0])).toMatchObject({ event: "lunora.mail.send_refused" });
        });

        it("refuses to requeue parked mail once its attempt record in the ledger has expired", async () => {
            expect.assertions(3);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);
            // Both clocks move together here, so this isolates the 15-day evidence lifetime from the
            // host-clock fix: only Date is faked, the mailer's deadline timer stays real.
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));

            const unknown = new MailSendError({ message: "socket hang up", outcomeUnknown: true, retryable: false });
            const transport = scriptedTransport([unknown, unknown, unknown, unknown, "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, transport: { ...transport, dedupesOnIdempotencyKey: true } });

            await mail.mailer.queue({ subject: "Reset", text: "Link", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
                vi.setSystemTime(Date.now() + 180_000);
            }

            const [parked] = mail.deadLetters.list();

            vi.setSystemTime(Date.now() + 16 * 86_400_000);

            expect(() => mail.deadLetters.requeue(parked?.id ?? "")).toThrow(/15 or more days/u);

            await mail.poll();

            expect(transport.sent).toHaveLength(4);
            expect(mail.deadLetters.list()).toHaveLength(1);
        });

        it("refuses a redelivery older than the ledger's attempt record, whatever route brought it back", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));

            const unknown = new MailSendError({ message: "socket hang up", outcomeUnknown: true, retryable: false });
            const transport = scriptedTransport([unknown, "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, transport: { ...transport, dedupesOnIdempotencyKey: true } });

            await mail.mailer.queue({ subject: "Reset", text: "Link", to: "ada@example.com" });
            await mail.poll();
            // The process was down for 16 days; the retry is due the moment it polls again.
            vi.setSystemTime(Date.now() + 16 * 86_400_000);
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
            expect(error.mock.calls.map(([line]) => logged(line).event)).toContain("lunora.mail.send_evidence_expired");
        });

        it("lets only one of two hosts on one file send a key while the other's send is in flight", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const clock = startClock();
            const database = freshDatabase();
            const path = database.name;
            const gate = blockingTransport();
            const other = scriptedTransport(["ok"]);
            // Two processes' worth of state: separate connections, one file.
            const first = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport: gate.transport });
            const secondDatabase = new Database(path);
            const second = createNodeMailHost(secondDatabase, { env: PRODUCTION, now: clock.now, transport: other });

            await first.mailer.queue({ idempotencyKey: "otp-bob", subject: "Code", text: "9876", to: "bob@example.com" });

            const sending = first.poll();

            await gate.entered;
            await second.mailer.queue({ idempotencyKey: "otp-bob", subject: "Code", text: "9876", to: "bob@example.com" });
            await second.poll();

            expect(other.sent).toStrictEqual([]);

            gate.release();
            await sending;
            clock.advance(180_000);
            await second.poll();
            secondDatabase.close();

            // The second host's retry found the key in the shared ledger and acked it unsent.
            expect(gate.sent.length + other.sent.length).toBe(1);
        });
    });

    describe("fourth review", () => {
        it("waits the full outcome-unknown delay after a send that failed late in a slow batch", async () => {
            expect.assertions(3);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const clock = startClock();
            const sent: SendPayload[] = [];
            const transport: MailTransport = {
                dedupesOnIdempotencyKey: true,
                send: async (payload) => {
                    sent.push(payload);

                    if (payload.subject === "Slow") {
                        // A send that took 200 s of host time: past the 180 s retry delay.
                        clock.advance(200_000);

                        return { id: "slow" };
                    }

                    if (sent.filter((entry) => entry.subject === "Late").length === 1) {
                        throw new MailSendError({ message: "socket hang up", outcomeUnknown: true, retryable: false });
                    }

                    return { id: "late" };
                },
            };
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ subject: "Slow", text: "1", to: "ada@example.com" });
            await mail.mailer.queue({ subject: "Late", text: "2", to: "bob@example.com" });
            await mail.poll();

            // Right after the batch: 200 s since it began, 0 s since "Late" failed.
            await expect(mail.poll()).resolves.toBe(0);

            clock.advance(180_000);
            await mail.poll();

            expect(sent.map((payload) => payload.subject)).toStrictEqual(["Slow", "Late", "Late"]);
            await expect(mail.poll()).resolves.toBe(0);
        });

        it("honours delaySeconds on the mail queue and refuses the options it cannot honour", async () => {
            expect.assertions(3);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });
            const body = { idempotencyKey: "digest-1", subject: "Digest", text: "Weekly", to: "ada@example.com" };

            await mail.queue.send(body, { delaySeconds: 60 });
            await mail.poll();

            expect(transport.sent).toStrictEqual([]);

            clock.advance(60_000);
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
            await expect(mail.queue.send(body, { contentType: "text" })).rejects.toThrow(/delaySeconds/u);
        });
    });

    describe("fifth review", () => {
        it("lets the first message queued under a key own it, even when a later one would be delivered first", async () => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            // Queued first but held back a minute: the later row would be due before it.
            await mail.queue.send({ idempotencyKey: "welcome-ada", subject: "Welcome", text: "Original", to: "ada@example.com" }, { delaySeconds: 60 });

            await expect(mail.mailer.queue({ idempotencyKey: "welcome-ada", subject: "Welcome", text: "Replacement", to: "ada@example.com" })).rejects.toThrow(
                /already queued with different content/u,
            );

            await mail.poll();
            clock.advance(60_000);
            await mail.poll();

            expect(transport.sent.map((payload) => payload.text)).toStrictEqual(["Original"]);
        });

        it("treats two bodies that send the same mail as the same content", async () => {
            expect.assertions(2);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            // A lone address and a one-element list are one recipient to the consumer.
            await mail.queue.send({ bcc: "audit@acme.test", idempotencyKey: "receipt-9", subject: "Receipt", text: "Paid", to: "ada@example.com" });
            await mail.queue.send({ bcc: ["audit@acme.test"], idempotencyKey: "receipt-9", subject: "Receipt", text: "Paid", to: ["ada@example.com"] });
            await mail.poll();

            // The second row is the same mail, so the ledger acks it unsent; it is no conflict.
            expect(transport.sent).toHaveLength(1);
            expect(error).not.toHaveBeenCalled();
        });

        it("prunes expired key records and abandoned claims", async () => {
            expect.assertions(3);

            const clock = startClock();
            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport: scriptedTransport(["ok"]) });
            const keys = (): unknown => database.prepare("SELECT key FROM _lunora_mail_keys ORDER BY key").all();

            await mail.mailer.queue({ idempotencyKey: "old-key", subject: "Old", text: "1", to: "ada@example.com" });
            await mail.poll();
            // A claim a crashed process never released.
            database.prepare("INSERT INTO _lunora_mail_claims (key, message_id, expires_at) VALUES ('crashed', 'gone', ?)").run(clock.now() - 1);

            clock.advance(25 * 60 * 60 * 1000);
            await mail.mailer.queue({ idempotencyKey: "new-key", subject: "New", text: "2", to: "ada@example.com" });
            await mail.poll();

            expect(keys()).toStrictEqual([{ key: "new-key" }]);
            expect(database.prepare("SELECT key FROM _lunora_mail_claims").all()).toStrictEqual([]);

            const plan = database.prepare<[number], { detail: string }>("EXPLAIN QUERY PLAN DELETE FROM _lunora_mail_keys WHERE expires_at <= ?").all(0);

            expect(plan.map((row) => row.detail).join(" ")).toContain("_lunora_mail_keys_expires");
        });

        it("lets a row redelivered after a crash take back its own key claim and send", async () => {
            expect.assertions(2);

            const clock = startClock();
            const database = freshDatabase();
            let announce: () => void = () => undefined;
            const stuckEntered = new Promise<void>((resolve) => {
                announce = resolve;
            });
            // Stands in for a process that crashed mid-send: a slow first send moves the clock 200 s,
            // so the second send (and its key claim) starts 200 s after the batch's lease began, then
            // never returns.
            const crashedTransport: MailTransport = {
                send: async (payload) => {
                    if (payload.subject === "Slow") {
                        clock.advance(200_000);

                        return { id: "slow" };
                    }

                    announce();

                    return await new Promise<never>(() => {
                        // Never settles: the process died here.
                    });
                },
            };
            const crashed = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport: crashedTransport });
            const survivorDatabase = new Database(database.name);
            const other = scriptedTransport(["ok"]);
            const survivor = createNodeMailHost(survivorDatabase, { env: PRODUCTION, now: clock.now, transport: other });

            await crashed.mailer.queue({ idempotencyKey: "slow-1", subject: "Slow", text: "1", to: "ada@example.com" });
            await crashed.mailer.queue({ idempotencyKey: "otp-cy", subject: "Code", text: "5555", to: "cy@example.com" });

            // Left running: it is the crashed process's poll, and it never finishes.
            crashed.poll().catch(() => undefined);
            await stuckEntered;
            // The batch's lease has run out, so its rows redeliver; the stuck send's claim, taken
            // 200 s into the batch, still has 200 s left.
            clock.advance(MAIL_LEASE_MS - 200_000);
            await survivor.poll();

            // "Slow" was recorded as sent before the crash, so only the stuck send goes out again.
            expect(other.sent.map((payload) => payload.to)).toStrictEqual(["cy@example.com"]);
            expect(survivorDatabase.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages").get()).toStrictEqual({ n: 0 });

            survivorDatabase.close();
        });

        it("sends at most one batch of ten per poll, so a backlog needs further polls", async () => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            for (let index = 0; index < 11; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- enqueue order is the claim order this pins
                await mail.mailer.queue({ subject: `Mail ${String(index)}`, text: "Hi", to: "ada@example.com" });
            }

            await mail.poll();

            expect(transport.sent).toHaveLength(10);

            await mail.poll();

            expect(transport.sent).toHaveLength(11);
        });
    });

    describe("sixth review", () => {
        it.each([
            ["negative", -1],
            ["NaN", Number.NaN],
            ["Infinity", Number.POSITIVE_INFINITY],
            ["fractional", 1.5],
            ["past the 24-hour ceiling", 86_401],
        ])("refuses a %s delaySeconds instead of delivering early", async (_label, delaySeconds) => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await expect(mail.queue.send({ idempotencyKey: "later", subject: "Later", text: "Hi", to: "ada@example.com" }, { delaySeconds })).rejects.toThrow(
                /whole number of seconds from 0 to 86400/u,
            );

            // Nothing was queued: not now, and not once any delay could have passed.
            await mail.poll();
            clock.advance(2 * 86_400_000);
            await mail.poll();

            expect(transport.sent).toStrictEqual([]);
        });

        it("accepts the full 24-hour delay and holds the send until then", async () => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.queue.send({ idempotencyKey: "tomorrow", subject: "Tomorrow", text: "Hi", to: "ada@example.com" }, { delaySeconds: 86_400 });
            clock.advance(86_399_000);
            await mail.poll();

            expect(transport.sent).toStrictEqual([]);

            clock.advance(1000);
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
        });

        it("captures under NODE_ENV=test exactly as on Cloudflare, and says so at startup", async () => {
            expect.assertions(4);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const env = { MAIL_FROM: PRODUCTION.MAIL_FROM, NODE_ENV: "test" };
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env, now: startClock().now, transport });

            // Cloudflare's own rule, the one createMailerFromEnv applies there.
            expect(shouldCaptureMail(env)).toBe(true);
            expect(warn.mock.calls[0]?.[0]).toMatch(/mail is captured, not sent \(NODE_ENV=test selects dev capture\).*DISCARDED/u);

            await mail.mailer.queue({ subject: "Reset", text: "Link", to: "ada@example.com" });
            await mail.poll();

            expect(transport.sent).toStrictEqual([]);
            expect(warn.mock.calls.filter(([line]) => String(line).includes("mail is captured, not sent"))).toHaveLength(1);
        });

        it("logs nothing about capture when it delivers", () => {
            expect.assertions(1);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            createNodeMailHost(freshDatabase(), { env: PRODUCTION, transport: scriptedTransport(["ok"]) });

            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe("coderabbit review", () => {
        it("keeps a key's content record for as long as the send's sent record", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const clock = startClock();
            const transport = scriptedTransport([new Error("connection refused"), "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "order-5", subject: "Order", text: "Shipped", to: "ada@example.com" });
            await mail.poll();
            // Sent on the retry at hour 22: the sent record lives to hour 46.
            clock.advance(22 * 60 * 60 * 1000);
            await mail.poll();
            clock.advance(3 * 60 * 60 * 1000);

            // Hour 25: past the enqueue-time record, inside the sent record. Reusing the key for
            // other content would otherwise be accepted, then acked as already sent.
            await expect(mail.mailer.queue({ idempotencyKey: "order-5", subject: "Order", text: "Cancelled", to: "ada@example.com" })).rejects.toThrow(
                /already queued with different content/u,
            );

            expect(transport.sent.map((payload) => payload.text)).toStrictEqual(["Shipped", "Shipped"]);
        });

        it("judges a second row of a key by the key's delivery history, not the row's own attempts", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

            // Both clocks move together: Resend's window is wall-clock time.
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));

            const unknown = new MailSendError({ message: "socket hang up", outcomeUnknown: true, retryable: false });
            const transport = scriptedTransport([unknown, "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, transport: { ...transport, dedupesOnIdempotencyKey: true } });
            const reset = { idempotencyKey: "reset-ada", subject: "Reset", text: "Link", to: "ada@example.com" };

            // The first row's only attempt may have landed.
            await mail.mailer.queue(reset);
            await mail.poll();

            // A day later the same mail is queued again: a new row, attempts 1, enqueued just now.
            vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
            await mail.mailer.queue(reset);
            await mail.poll();

            // Resend dedupes the key for 24 h from its first send, so either row going out could be a second copy.
            expect(transport.sent).toHaveLength(1);
            expect(error.mock.calls.map(([line]) => logged(line).event)).toContain("lunora.mail.send_outcome_unknown");
        });

        it("keeps mail delivery out of a shard transaction that rolls back", async () => {
            expect.assertions(2);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-tx-"));

            const transport = scriptedTransport(["ok"]);

            using platform = createNodePlatform({
                mail: { env: PRODUCTION, now: startClock().now, path: join(directory, "mail.sqlite3"), transport },
                path: join(directory, "shard.sqlite3"),
            });

            await platform.mail?.mailer.queue({ idempotencyKey: "welcome-1", subject: "Welcome", text: "Hi", to: "ada@example.com" });

            let release: () => void = () => undefined;
            let began: () => void = () => undefined;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const opened = new Promise<void>((resolve) => {
                began = resolve;
            });
            // A shard mutation that awaits, then fails: its BEGIN is open while mail polls.
            const mutation = platform.shard.transaction(async () => {
                began();
                await held;

                throw new Error("mutation failed");
            });

            // The closure runs only once the host has issued BEGIN, so this is the open transaction.
            await opened;
            await platform.mail?.poll();
            release();

            await expect(mutation).rejects.toThrow("mutation failed");

            // The ack and the sent record survived the rollback, so nothing goes out twice.
            await platform.mail?.poll();

            expect(transport.sent).toHaveLength(1);
        });
    });
});
