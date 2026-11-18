import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

/** The longest backoff the mail queue waits before a retry: 30 s doubled twice. */
const MAIL_MAX_BACKOFF_MS = 120_000;

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

    it("retries a failed send once its backoff has passed and logs the failure", async () => {
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

        clock.advance(30_000);
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
            clock.advance(MAIL_MAX_BACKOFF_MS);
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

    it("refuses an app queue named lunora-mail, even with mail in a file of its own", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-mail-names-"));

        const outbox = defineQueue({ handler: () => undefined, maxBatchTimeout: 0, name: "lunora-mail" });
        const root = directory;

        // Reserved outright: no connection or file split can make the two hosts' rows safe to share.
        expect(() =>
            createNodePlatform({
                mail: { env: PRODUCTION, now: startClock().now, path: join(root, "mail.sqlite3"), transport: scriptedTransport(["ok"]) },
                onQueueBatch: () => undefined,
                path: join(root, "shard.sqlite3"),
                queues: { outbox },
            }),
        ).toThrow(/"lunora-mail" is reserved for the mail host/u);
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

        it("parks, never sends, a requeued dead letter that may have landed once the provider's dedupe window has passed", async () => {
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

            // Any of the four may have been delivered, and Resend no longer drops a repeat of the key:
            // not sent, and parked again for an operator to check, never dropped.
            expect(transport.sent).toHaveLength(4);
            expect(mail.deadLetters.list()).toMatchObject([{ id: parked?.id, reason: "outcome_unknown" }]);
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
            const clock = startClock();
            const transport = scriptedTransport([new Error("connection refused")]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ subject: "Receipt", text: "Thanks", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                clock.advance(MAIL_MAX_BACKOFF_MS);
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
            const clock = startClock();
            const app = createNodeQueueHost(database, {
                onBatch: () => undefined,
                queues: { jobs: defineQueue({ handler: () => undefined, maxBatchTimeout: 0 }) },
            });
            const mail = createNodeMailHost(database, {
                env: PRODUCTION,
                now: clock.now,
                transport: scriptedTransport([new Error("connection refused")]),
            });

            await mail.mailer.queue({ subject: "Reset", text: "Link", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                clock.advance(MAIL_MAX_BACKOFF_MS);
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

            clock.advance(30_000);
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

            // Past the 15-day horizon a key record now shares with its delivery history.
            clock.advance(16 * 24 * 60 * 60 * 1000);
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

    describe("seventh review", () => {
        const DAY_MS = 24 * 60 * 60 * 1000;

        it("keeps a delayed row's key from new content after the key's record lapses", async () => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            // Due in 24 h: the key's record, written at enqueue, lapses before the row is sent.
            await mail.queue.send({ idempotencyKey: "digest-7", subject: "Digest", text: "Original", to: "ada@example.com" }, { delaySeconds: 86_400 });
            clock.advance(DAY_MS + 60_000);

            await expect(mail.mailer.queue({ idempotencyKey: "digest-7", subject: "Digest", text: "Replacement", to: "ada@example.com" })).rejects.toThrow(
                /already queued with different content/u,
            );

            await mail.poll();

            expect(transport.sent.map((payload) => payload.text)).toStrictEqual(["Original"]);
        });

        it("keeps a parked row's key from new content, so its requeue still sends it", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const clock = startClock();
            const refused = new Error("connection refused");
            const transport = scriptedTransport([refused, refused, refused, refused, "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "invoice-3", subject: "Invoice", text: "Original", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
            }

            clock.advance(DAY_MS + 60_000);

            await expect(mail.mailer.queue({ idempotencyKey: "invoice-3", subject: "Invoice", text: "Replacement", to: "ada@example.com" })).rejects.toThrow(
                /already queued with different content/u,
            );

            const [parked] = mail.deadLetters.list();

            mail.deadLetters.requeue(parked?.id ?? "");
            await mail.poll();

            expect(transport.sent.at(-1)?.text).toBe("Original");
        });

        it("parks, never acks, a row found superseded when it is delivered", async () => {
            expect.assertions(3);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const clock = startClock();
            const database = freshDatabase();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "welcome-9", subject: "Welcome", text: "Owner", to: "ada@example.com" });
            // A row queued before any content record existed (an older build, a raw producer): same key, other content.
            database
                .prepare(
                    "INSERT INTO _lunora_queue_messages (id, queue, body, content_type, visible_at, enqueued_at) VALUES ('legacy', 'lunora-mail', ?, 'json', ?, ?)",
                )
                .run(
                    Buffer.from(JSON.stringify({ idempotencyKey: "welcome-9", subject: "Welcome", text: "Legacy", to: "bob@example.com" })),
                    clock.now(),
                    clock.now(),
                );
            await mail.poll();

            expect(transport.sent.map((payload) => payload.text)).toStrictEqual(["Owner"]);
            expect(mail.deadLetters.list()).toMatchObject([{ body: { text: "Legacy" }, id: "legacy" }]);
            expect(error.mock.calls.map(([line]) => logged(line).event)).toContain("lunora.mail.idempotency_key_conflict");
        });

        it("keeps a key reserved while its delivery is in flight across the record's expiry", async () => {
            expect.assertions(1);

            const clock = startClock();
            const gate = blockingTransport();
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport: gate.transport });

            await mail.mailer.queue({ idempotencyKey: "otp-dee", subject: "Code", text: "1111", to: "dee@example.com" });
            clock.advance(DAY_MS - 60_000);

            const sending = mail.poll();

            await gate.entered;
            // The send is still awaited when the enqueue-time record would have lapsed.
            clock.advance(3 * 60_000);

            await expect(mail.mailer.queue({ idempotencyKey: "otp-dee", subject: "Code", text: "2222", to: "dee@example.com" })).rejects.toThrow(
                /already queued with different content/u,
            );

            gate.release();
            await sending;
        });

        it("keeps a reservation a concurrent enqueue of the same mail is using when another enqueue fails", async () => {
            expect.assertions(2);

            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport: scriptedTransport(["ok"]) });
            const mailFields = { idempotencyKey: "news-1", subject: "News", text: "Issue 1", to: "ada@example.com" };

            // Same mail, so one reservation; the first body is over the 128 KiB message ceiling.
            const oversized = mail.queue.send({ ...mailFields, padding: "x".repeat(200_000) });
            const accepted = mail.queue.send(mailFields);

            await expect(oversized).rejects.toThrow(/128 KiB/u);

            await accepted;

            expect(database.prepare("SELECT key FROM _lunora_mail_keys WHERE key = 'news-1'").get()).toStrictEqual({ key: "news-1" });
        });

        it("drains a mail poll that shard background work started during drain()", async () => {
            expect.assertions(2);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-waituntil-"));

            const mailPath = join(directory, "mail.sqlite3");
            const gate = blockingTransport();
            const platform = createNodePlatform({
                mail: { env: PRODUCTION, path: mailPath, transport: gate.transport },
                path: join(directory, "shard.sqlite3"),
            });

            await platform.mail?.mailer.queue({ subject: "Bye", text: "From the background", to: "ada@example.com" });

            let kick: () => void = () => undefined;
            const kicked = new Promise<void>((resolve) => {
                kick = resolve;
            });
            let polling: Promise<number> | undefined;

            expect(platform.shard.waitUntil).toBeDefined();

            // Background work that starts a poll only once drain() is already waiting on it.
            platform.shard.waitUntil?.(
                (async () => {
                    await kicked;
                    polling = platform.mail?.poll();
                })(),
            );

            const reader = new Database(mailPath, { readonly: true });
            let rowsWhenDrained: unknown;
            const drained = (async () => {
                await platform.drain();
                rowsWhenDrained = reader.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages").get();
            })();

            kick();
            await gate.entered;
            gate.release();
            await drained;
            await polling;
            reader.close();
            platform.close();

            expect(rowsWhenDrained).toStrictEqual({ n: 0 });
        });
    });

    describe("eighth review", () => {
        const mailFields = { idempotencyKey: "news-2", subject: "News", text: "Issue 2", to: "ada@example.com" };

        it("never lets another process on the file see a reservation without its row", async () => {
            expect.assertions(2);

            const enqueuing = freshDatabase();
            const watching = new Database(enqueuing.name);
            const clock = startClock();
            const writer = createNodeMailHost(enqueuing, { env: PRODUCTION, now: clock.now, transport: scriptedTransport(["ok"]) });
            const other = createNodeMailHost(watching, { env: PRODUCTION, now: clock.now, transport: scriptedTransport(["ok"]) });
            const windows: string[] = [];

            // The interleaving hook: inside the writer's row insert, before the row lands, look through the
            // other host's own connection. Under WAL it sees only what is committed, which is exactly what a
            // second process would act on: a reservation with no row is the state its failed-enqueue cleanup
            // deleted, freeing the key for different content while the writer's row was still to land.
            enqueuing.function("observe_reservation", (key: unknown) => {
                const reserved = watching.prepare("SELECT 1 FROM _lunora_mail_keys WHERE key = ?").get(key);
                const row = watching
                    .prepare("SELECT 1 FROM _lunora_queue_messages WHERE queue = 'lunora-mail' AND json_extract(CAST(body AS TEXT), '$.idempotencyKey') = ?")
                    .get(key);

                if (reserved !== undefined && row === undefined) {
                    windows.push(String(key));
                }

                return 0;
            });
            enqueuing.exec(
                // eslint-disable-next-line no-secrets/no-secrets -- trigger SQL, not a credential
                "CREATE TEMP TRIGGER observe BEFORE INSERT ON main._lunora_queue_messages BEGIN SELECT observe_reservation(json_extract(CAST(NEW.body AS TEXT), '$.idempotencyKey')); END",
            );

            // The other process's oversized enqueue of the same mail fails; then the writer queues it.
            await expect(other.queue.send({ ...mailFields, padding: "x".repeat(200_000) })).rejects.toThrow(/128 KiB/u);

            await writer.mailer.queue(mailFields);

            expect(windows).toStrictEqual([]);

            watching.close();
        });

        it("leaves no reservation behind when the row insert fails", async () => {
            expect.assertions(2);

            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport: scriptedTransport(["ok"]) });

            database.exec("CREATE TEMP TRIGGER refuse BEFORE INSERT ON main._lunora_queue_messages BEGIN SELECT RAISE(ABORT, 'disk full'); END");

            await expect(mail.mailer.queue(mailFields)).rejects.toThrow("disk full");

            expect(database.prepare("SELECT key FROM _lunora_mail_keys").all()).toStrictEqual([]);
        });

        it.each([
            ["the shard's own file", "path", "shard database"],
            ["the shard's file under another spelling", "path via ..", "shard database"],
            ["the .global() store's file", "globalTablesPath", "globalTablesPath"],
            ["a shard file in the registry's directory", "directory", "shard registry's directory"],
        ])("refuses a mail.path that is %s, naming both", (_label, owner, named) => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-shared-"));

            const root = directory;
            const mailPath = join(root, "shard.sqlite3");
            const owners: Record<string, { directory?: string; globalTablesPath?: string; path?: string }> = {
                directory: { directory: root },
                globalTablesPath: { globalTablesPath: mailPath },
                path: { path: mailPath },
                "path via ..": { path: join(root, "sub", "..", "shard.sqlite3") },
            };

            expect(() =>
                createNodePlatform({
                    path: join(root, "other-shard.sqlite3"),
                    ...owners[owner],
                    mail: { env: PRODUCTION, path: mailPath, transport: scriptedTransport(["ok"]) },
                }),
            ).toThrow(new RegExp(String.raw`mail\.path ".*shard\.sqlite3".*${named.replaceAll(".", String.raw`\.`)}`, "u"));
        });

        it("accepts a mail.path distinct from every database the platform opens", () => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-distinct-"));

            const root = directory;

            using platform = createNodePlatform({
                directory: join(root, "shards"),
                globalTablesPath: join(root, "global.sqlite3"),
                mail: { env: PRODUCTION, path: join(root, "mail.sqlite3"), transport: scriptedTransport(["ok"]) },
                path: join(root, "shard.sqlite3"),
            });

            expect(platform.mail).toBeDefined();
        });

        it("names the variable that decided capture when LUNORA_MAIL_CAPTURE holds a value it ignores", () => {
            expect.assertions(2);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            createNodeMailHost(freshDatabase(), {
                env: { LUNORA_MAIL_CAPTURE: "yes", MAIL_FROM: PRODUCTION.MAIL_FROM, NODE_ENV: "test" },
                transport: scriptedTransport(["ok"]),
            });

            const announced = warn.mock.calls.map(([line]) => String(line)).find((line) => line.includes("mail is captured, not sent"));

            expect(announced).toContain("(NODE_ENV=test selects dev capture; LUNORA_MAIL_CAPTURE=yes was ignored, as only 1, true, 0 or false are read)");
            expect(announced).not.toMatch(/\(LUNORA_MAIL_CAPTURE=yes selects/u);
        });
    });

    describe("ninth review", () => {
        it.each([
            ["the shard's file", "path", "shard database"],
            ["the .global() store's file", "globalTablesPath", "globalTablesPath"],
            ["a registry shard file, linked from outside its directory", "directory", "shard registry's shard"],
        ])("refuses a mail.path hard-linked to %s", (_label, owner, named) => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-hardlink-"));

            const root = directory;
            const shards = join(root, "shards");

            mkdirSync(shards);

            // The file another host already uses, and a hard link to it: another path, the same inode,
            // which realpath does not resolve.
            const target = owner === "directory" ? join(shards, "tenant.sqlite3") : join(root, "owned.sqlite3");

            new Database(target).close();

            const mailPath = join(root, "mail.sqlite3");

            linkSync(target, mailPath);

            const owners: Record<string, { directory?: string; globalTablesPath?: string; path?: string }> = {
                directory: { directory: shards },
                globalTablesPath: { globalTablesPath: target },
                path: { path: target },
            };

            expect(() =>
                createNodePlatform({
                    path: join(root, "shard.sqlite3"),
                    ...owners[owner],
                    mail: { env: PRODUCTION, path: mailPath, transport: scriptedTransport(["ok"]) },
                }),
            ).toThrow(new RegExp(named.replaceAll(".", String.raw`\.`), "u"));
        });
    });

    describe("tenth review", () => {
        it("reserves the content it stores, so a payload whose toJSON() changes a field is delivered", async () => {
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: startClock().now, transport });
            const stored = { idempotencyKey: "serialised-1", subject: "Welcome", text: "As stored", to: "ada@example.com" };

            // Valid mail either way, but JSON.stringify stores what toJSON() returns, not the object's own fields.
            await mail.queue.send({ ...stored, text: "As passed", toJSON: () => stored });
            await mail.poll();

            expect(transport.sent.map((payload) => payload.text)).toStrictEqual(["As stored"]);
            expect(mail.deadLetters.list()).toStrictEqual([]);
        });

        /** A `mail.sqlite3` symlink inside the registry directory, to a target outside it. */
        const symlinkedMailPath = (): { link: string; root: string; shards: string; target: string } => {
            directory = mkdtempSync(join(tmpdir(), "lunora-mail-symlink-"));

            const root = directory;
            const shards = join(root, "shards");

            mkdirSync(shards);

            return { link: join(shards, "mail.sqlite3"), root, shards, target: join(root, "elsewhere.sqlite3") };
        };

        /** The registry lists every *.sqlite3 entry without resolving it, so it would open the link as a shard. */
        const composeOn = ({ link, root, shards }: { link: string; root: string; shards: string }): void => {
            createNodePlatform({
                directory: shards,
                mail: { env: PRODUCTION, path: link, transport: scriptedTransport(["ok"]) },
                path: join(root, "shard.sqlite3"),
            }).close();
        };

        it("refuses a mail.path that is a symlink inside the registry directory to an existing file outside it", () => {
            expect.assertions(1);

            const paths = symlinkedMailPath();

            new Database(paths.target).close();
            symlinkSync(paths.target, paths.link);

            expect(() => {
                composeOn(paths);
            }).toThrow(/shard registry/u);
        });

        it("refuses a mail.path that is a symlink inside the registry directory to a file not created yet", () => {
            expect.assertions(1);

            const paths = symlinkedMailPath();

            symlinkSync(paths.target, paths.link);

            expect(() => {
                composeOn(paths);
            }).toThrow(/shard registry/u);
        });
    });

    describe("eleventh review", () => {
        it.each([
            ["the empty string", ""],
            [":memory:", ":memory:"],
        ])("refuses %s as mail.path, since the mail queue must be durable", (_label, mailPath) => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-durable-"));

            expect(() =>
                createNodePlatform({
                    mail: { env: PRODUCTION, path: mailPath, transport: scriptedTransport(["ok"]) },
                    path: join(directory ?? "", "shard.sqlite3"),
                }),
            ).toThrow(/not durable/u);
        });

        it("logs a failed key claim like any delivery failure, and retries the send", async () => {
            expect.assertions(4);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const database = freshDatabase();
            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "claim-1", subject: "Hi", text: "Hi", to: "ada@example.com" });
            // The claim's insert fails, as a locked or corrupt database would make it.
            database.exec("CREATE TEMP TRIGGER no_claims BEFORE INSERT ON main._lunora_mail_claims BEGIN SELECT RAISE(ABORT, 'claims unavailable'); END");
            await mail.poll();

            const line = logged(warn.mock.calls[0]?.[0]) as { attempts: number; error: { cause?: { message: string }; message: string }; event: string };

            expect(line).toMatchObject({ attempts: 1, event: "lunora.mail.send_retry" });
            expect(line.error.message).toContain('"claim-1"');
            expect(line.error.cause?.message).toContain("claims unavailable");

            // Retried, not dropped: once the claim works the send goes out.
            database.exec("DROP TRIGGER no_claims");
            clock.advance(30_000);
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
        });

        it("decodes a stored body only for mail, never on a plain queue send", async () => {
            expect.assertions(3);

            const database = freshDatabase();
            const app = createNodeQueueHost(database, {
                onBatch: () => undefined,
                queues: { jobs: defineQueue({ handler: () => undefined, maxBatchTimeout: 0 }) },
            });
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport });
            // JSON.parse is the decoder for a JSON body: a plain send has no use for the decoded value.
            const decode = vi.spyOn(JSON, "parse");

            await app.bindings.jobs.send({ n: 1 });

            expect(decode).not.toHaveBeenCalled();

            await mail.queue.send({ idempotencyKey: "decoded-1", subject: "Hi", text: "Hi", to: "ada@example.com" });

            // The mail host reads the stored value to take its key and fingerprint.
            expect(decode).toHaveBeenCalledWith(expect.stringContaining('"idempotencyKey":"decoded-1"'));

            decode.mockRestore();
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
        });
    });

    describe("twelfth review", () => {
        it("refuses a mail.path that names the shard's file with a stray space, as better-sqlite3 trims it", () => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-trim-"));

            const shardPath = join(directory, "shard.sqlite3");

            // better-sqlite3 opens `filename.trim()`: this would be the shard's own database.
            expect(() =>
                createNodePlatform({ mail: { env: PRODUCTION, path: `${shardPath} `, transport: scriptedTransport(["ok"]) }, path: shardPath }),
            ).toThrow(/shard database/u);
        });
    });

    describe("thirteenth review", () => {
        const DAY_MS = 24 * 60 * 60 * 1000;

        it("refuses at enqueue a key reused with new content days after it was sent", async () => {
            expect.assertions(2);

            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "order-9", subject: "Order", text: "Shipped", to: "ada@example.com" });
            await mail.poll();
            clock.advance(3 * DAY_MS);

            // Inside the key's 15-day history: accepted, it would be dropped as a late repeat of the old send.
            await expect(mail.mailer.queue({ idempotencyKey: "order-9", subject: "Order", text: "Cancelled", to: "ada@example.com" })).rejects.toThrow(
                /already queued with different content/u,
            );

            expect(transport.sent.map((payload) => payload.text)).toStrictEqual(["Shipped"]);
        });

        it("refuses a same-key row left pending past the evidence horizon, after another row of the key was sent", async () => {
            expect.assertions(2);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });
            const reset = { idempotencyKey: "reset-zoe", subject: "Reset", text: "Link", to: "zoe@example.com" };

            await mail.mailer.queue(reset);
            await mail.poll();
            // The same mail queued again, then nothing polls for 16 days: the key's history and sent record lapse.
            await mail.mailer.queue(reset);
            clock.advance(16 * DAY_MS);
            await mail.poll();

            expect(transport.sent).toHaveLength(1);
            expect(error.mock.calls.map(([line]) => logged(line).event)).toContain("lunora.mail.send_evidence_expired");
        });

        const outbox = (): ReturnType<typeof defineQueue> => defineQueue({ handler: () => undefined, name: "lunora-mail" });

        it("refuses an app queue named lunora-mail on the mail host's own connection", () => {
            expect.assertions(1);

            const database = freshDatabase();

            createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport: scriptedTransport(["ok"]) });

            expect(() => createNodeQueueHost(database, { onBatch: () => undefined, queues: { outbox: outbox() } })).toThrow(/is reserved for the mail host/u);
        });

        it("refuses an app queue named lunora-mail on a second connection to the mail file", () => {
            expect.assertions(1);

            // A per-connection registry cannot see this one: a separate connection, as a second process has.
            const database = freshDatabase();

            createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport: scriptedTransport(["ok"]) });

            const second = new Database(database.name);

            try {
                expect(() => createNodeQueueHost(second, { onBatch: () => undefined, queues: { outbox: outbox() } })).toThrow(/is reserved for the mail host/u);
            } finally {
                second.close();
            }
        });

        it("logs a failed content update after a send as its own error, never as a refusal", async () => {
            expect.assertions(4);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const database = freshDatabase();
            const sent: SendPayload[] = [];
            const transport: MailTransport = {
                send: async (payload) => {
                    sent.push(payload);
                    // Once the provider has the mail, the key's content update fails (a busy database, say).
                    database.exec("CREATE TEMP TRIGGER keys_busy BEFORE UPDATE ON main._lunora_mail_keys BEGIN SELECT RAISE(ABORT, 'keys busy'); END");

                    return { id: "sent-1" };
                },
            };
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport });

            await mail.mailer.queue({ idempotencyKey: "after-1", subject: "Hi", text: "Hi", to: "ada@example.com" });
            await mail.poll();
            await mail.poll();

            const events = error.mock.calls.map(([line]) => logged(line).event);

            expect(sent).toHaveLength(1);
            expect(events).toContain("lunora.mail.content_record_failed");
            expect(events).not.toContain("lunora.mail.send_refused");
            expect(database.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages").get()).toStrictEqual({ n: 0 });
        });

        it("logs a failed claim release and still delivers the rest of the batch", async () => {
            expect.assertions(2);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const database = freshDatabase();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport });

            await mail.mailer.queue({ idempotencyKey: "batch-1", subject: "One", text: "1", to: "ada@example.com" });
            await mail.mailer.queue({ idempotencyKey: "batch-2", subject: "Two", text: "2", to: "bob@example.com" });
            database.exec("CREATE TEMP TRIGGER claims_stuck BEFORE DELETE ON main._lunora_mail_claims BEGIN SELECT RAISE(ABORT, 'claims stuck'); END");
            await mail.poll();

            expect(transport.sent.map((payload) => payload.subject)).toStrictEqual(["One", "Two"]);
            expect(error.mock.calls.map(([line]) => logged(line).event)).toContain("lunora.mail.claim_release_failed");
        });
    });

    describe("fourteenth review", () => {
        it("retries a row first polled long after it was queued, measuring evidence from its first attempt", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const clock = startClock();
            const transport = scriptedTransport([new Error("connection refused"), "ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "late-1", subject: "Hi", text: "Hi", to: "ada@example.com" });
            // Nothing polls for 16 days; then the first attempt fails transiently.
            clock.advance(16 * 24 * 60 * 60 * 1000);
            await mail.poll();
            clock.advance(30_000);
            await mail.poll();

            // Its first attempt was moments ago, so its evidence is fresh: retried and sent, not expired.
            expect(transport.sent).toHaveLength(2);
            expect(error.mock.calls.map(([line]) => logged(line).event)).not.toContain("lunora.mail.send_evidence_expired");
        });
    });

    describe("fifteenth review", () => {
        it("keeps a registry directory's trailing space, as the registry itself does", () => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-dirspace-"));

            // "shards " is a real directory name: only database filenames are trimmed.
            const shards = join(directory, "shards ");

            mkdirSync(shards);

            expect(() =>
                createNodePlatform({
                    directory: shards,
                    mail: { env: PRODUCTION, path: join(shards, "mail.sqlite3"), transport: scriptedTransport(["ok"]) },
                    path: join(directory ?? "", "shard.sqlite3"),
                }),
            ).toThrow(/shard registry's directory/u);
        });
    });

    describe("sixteenth review", () => {
        it("delivers one of two fresh matching sends queued after the key's history expired", async () => {
            expect.assertions(2);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const clock = startClock();
            const transport = scriptedTransport(["ok"]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });
            const digest = { idempotencyKey: "digest-q", subject: "Digest", text: "Quarter", to: "ada@example.com" };

            await mail.mailer.queue(digest);
            await mail.poll();
            // Ten seconds before the key's 15-day history expires, another enqueue runs the prune,
            // which keeps the history, still live. Pruning then waits a minute.
            clock.advance(15 * 24 * 60 * 60 * 1000 - 10_000);
            await mail.mailer.queue({ idempotencyKey: "other-1", subject: "Other", text: "x", to: "bob@example.com" });
            // Twenty seconds on, the history has expired but is not yet pruned. Two fresh matching
            // sends are queued after that expiry: a new use of the key, which must reset it.
            clock.advance(20_000);
            await mail.mailer.queue({ ...digest, text: "Next quarter" });
            await mail.mailer.queue({ ...digest, text: "Next quarter" });
            await mail.poll();

            // One of the pair is sent; the other is its duplicate and is acked unsent.
            expect(transport.sent.filter((payload) => payload.subject === "Digest").map((payload) => payload.text)).toStrictEqual(["Quarter", "Next quarter"]);
            expect(error.mock.calls.map(([line]) => logged(line).event)).not.toContain("lunora.mail.send_evidence_expired");
        });
    });

    describe("seventeenth review", () => {
        it.each([
            ["a plain file: URI", "file:mail.sqlite3"],
            ["a file::memory: URI", "file::memory:"],
            ["a mode=memory URI", "file:mail.sqlite3?mode=memory&cache=shared"],
        ])("refuses %s as mail.path, asking for a plain filesystem path", (_label, mailPath) => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-uri-"));

            // better-sqlite3 reads none of these as a URI: each would open a file by its literal name.
            expect(() =>
                createNodePlatform({
                    mail: { env: PRODUCTION, path: mailPath, transport: scriptedTransport(["ok"]) },
                    path: join(directory ?? "", "shard.sqlite3"),
                }),
            ).toThrow(/is a file: URI — pass a plain filesystem path/u);
        });
    });

    describe("eighteenth review", () => {
        const DAY_MS = 24 * 60 * 60 * 1000;

        it("parks a superseded row found by a poll that an overlapping poll outlives", async () => {
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const clock = startClock();
            const database = freshDatabase();
            const { entered, release, transport } = blockingTransport();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ idempotencyKey: "welcome-10", subject: "Welcome", text: "Owner", to: "ada@example.com" });
            // A row queued before any content record existed (an older build, a raw producer): same key,
            // other content. Ahead of the owner in the claim's rowid order, so the batch finds it
            // superseded first, then sends the owner, which the transport holds open.
            database
                .prepare(
                    "INSERT INTO _lunora_queue_messages (rowid, id, queue, body, content_type, visible_at, enqueued_at) VALUES (0, 'legacy', 'lunora-mail', ?, 'json', ?, ?)",
                )
                .run(
                    Buffer.from(JSON.stringify({ idempotencyKey: "welcome-10", subject: "Welcome", text: "Legacy", to: "bob@example.com" })),
                    clock.now(),
                    clock.now(),
                );

            const first = mail.poll();

            // A second poll overlapping it claims nothing and finishes first, before the legacy row is
            // settled. An operator then requeues whatever is parked, before the first poll settles.
            await entered;

            await expect(mail.poll()).resolves.toBe(0);

            for (const parked of mail.deadLetters.list()) {
                mail.deadLetters.requeue(parked.id);
            }

            release();
            await first;

            expect(mail.deadLetters.list()).toMatchObject([{ body: { text: "Legacy" }, id: "legacy" }]);
        });

        it("runs the platform's teardowns once, however often it is closed", () => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-mail-close-"));

            const close = vi.spyOn(Database.prototype, "close");
            const platform = createNodePlatform({
                mail: { env: PRODUCTION, path: join(directory, "mail.sqlite3"), transport: scriptedTransport(["ok"]) },
                path: join(directory, "shard.sqlite3"),
            });

            platform.close();

            const once = close.mock.calls.length;

            platform.close();
            platform[Symbol.dispose]();

            expect(close).toHaveBeenCalledTimes(once);
        });

        it("still sends a failed delivery's retry past the dedupe window when the failed mark cannot be written", async () => {
            expect.assertions(2);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const clock = startClock();
            const database = freshDatabase();
            const transport = scriptedTransport([new MailSendError({ message: "provider is down", retryable: true }), "ok"]);
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });

            // The ledger refuses the failed mark, as a write the database cannot take would.
            database.exec(
                "CREATE TRIGGER refuse_failed_mark BEFORE INSERT ON _lunora_mail_sent WHEN NEW.value = 'failed' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
            );

            await mail.mailer.queue({ idempotencyKey: "reset-7", subject: "Reset", text: "Code 1234", to: "ada@example.com" });
            await mail.poll();
            // Retried a day later, past Resend's 24-hour window, where the attempt marks are read.
            clock.advance(DAY_MS + 60_000);
            await mail.poll();

            // Delivery 1 never went out, so delivery 2 is sent, not refused as a possible repeat.
            expect(transport.sent.map((payload) => payload.text)).toStrictEqual(["Code 1234", "Code 1234"]);
            expect(mail.deadLetters.list()).toStrictEqual([]);
        });

        it("backs a plain retryable failure off 30 s, then 60 s, then 120 s before parking it", async () => {
            expect.assertions(4);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const clock = startClock();
            const transport = scriptedTransport([new MailSendError({ message: "429 rate limited", retryable: true })]);
            const mail = createNodeMailHost(freshDatabase(), { env: PRODUCTION, now: clock.now, transport });

            await mail.mailer.queue({ subject: "Verify", text: "Code 5678", to: "ada@example.com" });

            /** Poll a second before the retry is due, then on it, and answer how many sends each had made. */
            const pollAround = async (delayMs: number): Promise<[number, number]> => {
                clock.advance(delayMs - 1000);
                await mail.poll();

                const early = transport.sent.length;

                clock.advance(1000);
                await mail.poll();

                return [early, transport.sent.length];
            };

            await mail.poll();

            // A send's own time is not on this clock, so each retry is due exactly its delay after the failure.
            await expect(pollAround(30_000)).resolves.toStrictEqual([1, 2]);
            await expect(pollAround(60_000)).resolves.toStrictEqual([2, 3]);
            await expect(pollAround(120_000)).resolves.toStrictEqual([3, 4]);

            expect(mail.deadLetters.list()).toMatchObject([{ attempts: 4, body: { subject: "Verify" } }]);
        });
    });

    describe("nineteenth review", () => {
        const DAY_MS = 24 * 60 * 60 * 1000;

        it("parks as outcome_unknown, never acks, a send whose attempt marks could not be written or cleared", async () => {
            expect.assertions(4);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const clock = startClock();
            const database = freshDatabase();
            const down = new MailSendError({ message: "provider is down", retryable: true });
            const transport = scriptedTransport([down, down, down, down, "ok"]);
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: clock.now, transport });

            // Neither the failed mark nor the fallback delete of the sending mark can be written.
            database.exec(
                "CREATE TRIGGER refuse_failed_mark BEFORE INSERT ON _lunora_mail_sent WHEN NEW.value = 'failed' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
            );
            database.exec(
                "CREATE TRIGGER keep_sending_mark BEFORE DELETE ON _lunora_mail_sent WHEN OLD.value = 'sending' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
            );

            await mail.mailer.queue({ idempotencyKey: "reset-8", subject: "Reset", text: "Code 4321", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                clock.advance(MAIL_MAX_BACKOFF_MS);
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
            }

            // Requeued past Resend's 24-hour window: each orphaned sending mark reads as a send that may have landed.
            clock.advance(DAY_MS + 60_000);

            const [parked] = mail.deadLetters.list();

            mail.deadLetters.requeue(parked?.id ?? "");
            await mail.poll();

            const events = error.mock.calls.map(([line]) => logged(line).event);

            expect(transport.sent).toHaveLength(4);
            expect(mail.deadLetters.list()).toMatchObject([{ id: parked?.id, reason: "outcome_unknown" }]);
            expect(events).toContain("lunora.mail.attempt_mark_orphaned");
            expect(events).toContain("lunora.mail.send_outcome_unknown");
        });

        it("refuses a send with neither text nor html at enqueue, instead of retrying it into deadLetters", async () => {
            expect.assertions(2);

            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport: scriptedTransport(["ok"]) });

            await expect(mail.mailer.queue({ subject: "Empty", to: "ada@example.com" })).rejects.toThrow(/needs `text` or `html`/u);
            expect(database.prepare("SELECT COUNT(*) AS n FROM _lunora_queue_messages").get()).toStrictEqual({ n: 0 });
        });
    });

    describe("twentieth review", () => {
        /** A transport whose send may have landed and is not deduped: the send is parked as outcome_unknown. */
        const smtpTimeout = (): MailTransport & { sent: SendPayload[] } =>
            scriptedTransport([new MailSendError({ message: "SMTP timed out", outcomeUnknown: true, retryable: false })]);

        it("parks no row without its reason when the reason cannot be written", async () => {
            expect.assertions(2);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport: smtpTimeout() });

            database.exec("CREATE TRIGGER refuse_reason BEFORE INSERT ON _lunora_mail_parked BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");

            await mail.mailer.queue({ subject: "Invoice", text: "Due", to: "ada@example.com" });
            await mail.poll().catch(() => undefined);

            // Rolled back with its reason: still queued under its long retry, not parked as `unknown`.
            expect(mail.deadLetters.list()).toStrictEqual([]);
            expect(error.mock.calls.map(([line]) => logged(line).event)).toContain("lunora.mail.park_failed");
        });

        it("keeps the reason of a park that lands between a requeue's revive and its reason's removal", async () => {
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const database = freshDatabase();
            const mail = createNodeMailHost(database, { env: PRODUCTION, now: startClock().now, transport: smtpTimeout() });

            await mail.mailer.queue({ subject: "Invoice", text: "Due", to: "ada@example.com" });
            await mail.poll();

            const [parked] = mail.deadLetters.list();
            const id = parked?.id ?? "";
            // Another process on the same file, parking the row again with its own reason. With no
            // busy wait, so it fails fast while the requeue holds the write lock, and is retried after.
            const other = new Database(database.name, { timeout: 0 });
            const parkElsewhere = (): void => {
                other.transaction(() => {
                    other.prepare("UPDATE _lunora_queue_messages SET state = 'dead' WHERE id = ?").run(id);
                    other.prepare("INSERT OR REPLACE INTO _lunora_mail_parked (id, reason) VALUES (?, 'idempotency_key_conflict')").run(id);
                })();
            };
            const statement = Object.getPrototypeOf(database.prepare("SELECT 1")) as { run: (...parameters: unknown[]) => unknown };
            const { run } = statement;
            const deferred: (() => void)[] = [];

            vi.spyOn(statement, "run").mockImplementation(function interleave(this: { source: string }, ...parameters: unknown[]) {
                const result = run.apply(this, parameters);

                if (this.source.startsWith("UPDATE _lunora_queue_messages SET state = 'pending'")) {
                    try {
                        parkElsewhere();
                    } catch {
                        deferred.push(parkElsewhere);
                    }
                }

                return result;
            });

            mail.deadLetters.requeue(id);
            vi.mocked(statement.run).mockRestore();

            for (const parkLater of deferred) {
                parkLater();
            }

            other.close();

            // The later park's reason is what an operator reads, not `unknown` from a removal that ran after it.
            expect(mail.deadLetters.list()).toMatchObject([{ id, reason: "idempotency_key_conflict" }]);
            expect(deferred).toHaveLength(1);
        });

        it("lists a send the queue host parked on its last retry as retries_exhausted", async () => {
            expect.assertions(1);

            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const clock = startClock();
            const mail = createNodeMailHost(freshDatabase(), {
                env: PRODUCTION,
                now: clock.now,
                transport: scriptedTransport([new MailSendError({ message: "provider is down", retryable: true })]),
            });

            await mail.mailer.queue({ subject: "Receipt", text: "Thanks", to: "ada@example.com" });

            for (let delivery = 0; delivery < 4; delivery += 1) {
                clock.advance(MAIL_MAX_BACKOFF_MS);
                // eslint-disable-next-line no-await-in-loop -- each poll settles the previous delivery before the next is claimed
                await mail.poll();
            }

            expect(mail.deadLetters.list()).toMatchObject([{ attempts: 4, reason: "retries_exhausted" }]);
        });
    });
});
