import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlExec } from "../src/ctx-db";
import type { RecordQueueMessageInput } from "../src/queue-catcher";
import {
    clearQueueMessages,
    ensureQueueTable,
    isLossyBody,
    MAX_BODY_CHARS,
    QUEUE_RETENTION,
    QUEUE_TABLE,
    readQueueMessageById,
    readQueueMessages,
    recordQueueMessages,
} from "../src/queue-catcher";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The dev queue catcher — the reserved `__lunora_queue_messages` table backing
 * the studio Queues panel, the only way to see what a push consumer actually
 * processed (Cloudflare Queues exposes no peek API). Runs against a real
 * SQLite build so retention deletes, ordering and the JSON body round-trip all
 * behave the way they will inside a Durable Object.
 */
describe("queue-catcher", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let sql: SqlExec;

    const baseInput: RecordQueueMessageInput = {
        attempts: 1,
        body: { hello: "world" },
        messageId: "msg-1",
        outcome: "ack",
        queue: "emails",
        timestamp: 1000,
    };

    beforeEach(() => {
        harness = createSqliteExec();
        sql = harness.sql;
    });

    afterEach(() => {
        harness.close();
    });

    describe(ensureQueueTable, () => {
        it("is idempotent", () => {
            expect.assertions(1);

            ensureQueueTable(sql);
            ensureQueueTable(sql);

            expect(readQueueMessages(sql).entries).toStrictEqual([]);
        });
    });

    describe(readQueueMessages, () => {
        it("returns an empty list on an app whose consumers have never run", () => {
            expect.assertions(1);

            expect(readQueueMessages(sql).entries).toStrictEqual([]);
        });
    });

    describe(recordQueueMessages, () => {
        it("creates the table on first use", () => {
            expect.assertions(1);

            recordQueueMessages(sql, [baseInput], 5000);

            const rows = harness.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, QUEUE_TABLE);

            expect(rows).toHaveLength(1);
        });

        it("round-trips a message body, decoding it back to the same value", () => {
            expect.assertions(1);

            recordQueueMessages(sql, [baseInput], 5000);

            const { entries } = readQueueMessages(sql);

            expect(entries[0]?.body).toStrictEqual({ hello: "world" });
        });

        it("returns the number of messages recorded", () => {
            expect.assertions(1);

            const result = recordQueueMessages(sql, [baseInput, { ...baseInput, messageId: "msg-2" }], 5000);

            expect(result).toStrictEqual({ recorded: 2 });
        });

        it("records attempts, outcome, deadLettered and error verbatim", () => {
            expect.assertions(1);

            recordQueueMessages(sql, [{ ...baseInput, attempts: 3, deadLettered: true, error: "boom", exportName: "sendWelcome", outcome: "error" }], 5000);

            const { entries } = readQueueMessages(sql);

            expect(entries[0]).toMatchObject({ attempts: 3, deadLettered: true, error: "boom", exportName: "sendWelcome", outcome: "error" });
        });

        it("leaves exportName/error undefined (not empty string) when absent", () => {
            expect.assertions(2);

            recordQueueMessages(sql, [baseInput], 5000);

            const { entries } = readQueueMessages(sql);

            expect(entries[0]?.exportName).toBeUndefined();
            expect(entries[0]?.error).toBeUndefined();
        });

        it("orders newest first by capturedAt", () => {
            expect.assertions(1);

            recordQueueMessages(sql, [{ ...baseInput, messageId: "first" }], 1000);
            recordQueueMessages(sql, [{ ...baseInput, messageId: "second" }], 2000);

            const { entries } = readQueueMessages(sql);

            expect(entries.map((entry) => entry.messageId)).toStrictEqual(["second", "first"]);
        });

        it("trims the log back to QUEUE_RETENTION rows after each write", () => {
            expect.assertions(1);

            for (let index = 0; index < QUEUE_RETENTION + 5; index += 1) {
                recordQueueMessages(sql, [{ ...baseInput, messageId: `msg-${String(index)}` }], index);
            }

            const { entries } = readQueueMessages(sql, { limit: QUEUE_RETENTION });

            expect(entries).toHaveLength(QUEUE_RETENTION);
        });

        it("filters by queue name", () => {
            expect.assertions(1);

            recordQueueMessages(sql, [{ ...baseInput, messageId: "a", queue: "emails" }], 1000);
            recordQueueMessages(sql, [{ ...baseInput, messageId: "b", queue: "webhooks" }], 2000);

            const { entries } = readQueueMessages(sql, { queue: "webhooks" });

            expect(entries.map((entry) => entry.messageId)).toStrictEqual(["b"]);
        });

        it("caps an oversized body with a visible truncation marker", () => {
            expect.assertions(2);

            const oversized = "x".repeat(MAX_BODY_CHARS + 100);

            recordQueueMessages(sql, [{ ...baseInput, body: oversized }], 5000);

            const { entries } = readQueueMessages(sql);
            const body = entries[0]?.body;

            expect(typeof body).toBe("string");
            expect(isLossyBody(body)).toBe(true);
        });

        it("stores a diagnostic marker for a body that can't be JSON-encoded", () => {
            expect.assertions(2);

            // A function value stringifies to `undefined`, which is what
            // `encodeBody` treats as "unserializable" (its .length access throws).
            recordQueueMessages(sql, [{ ...baseInput, body: () => {} }], 5000);

            const { entries } = readQueueMessages(sql);

            expect(entries[0]?.body).toBe("[unserializable message body]");
            expect(isLossyBody(entries[0]?.body)).toBe(true);
        });

        it("stores an undefined body as null", () => {
            expect.assertions(1);

            recordQueueMessages(sql, [{ ...baseInput, body: undefined }], 5000);

            const { entries } = readQueueMessages(sql);

            expect(entries[0]?.body).toBeNull();
        });
    });

    describe(readQueueMessageById, () => {
        it("returns undefined for an id that was never captured", () => {
            expect.assertions(1);

            expect(readQueueMessageById(sql, "nope")).toBeUndefined();
        });

        it("reads a single captured row by its synthetic id", () => {
            expect.assertions(1);

            recordQueueMessages(sql, [baseInput], 5000);

            const { entries } = readQueueMessages(sql);
            const id = entries[0]?.id;

            expect(readQueueMessageById(sql, id ?? "")).toStrictEqual(entries[0]);
        });
    });

    describe(clearQueueMessages, () => {
        it("empties the log", () => {
            expect.assertions(2);

            recordQueueMessages(sql, [baseInput], 5000);

            expect(readQueueMessages(sql).entries).toHaveLength(1);

            clearQueueMessages(sql);

            expect(readQueueMessages(sql).entries).toHaveLength(0);
        });

        it("is safe to call on a never-audited shard", () => {
            expect.assertions(1);

            expect(clearQueueMessages(sql)).toStrictEqual({ cleared: true });
        });
    });

    describe(isLossyBody, () => {
        it("is false for an ordinary decoded object body", () => {
            expect.assertions(1);

            expect(isLossyBody({ hello: "world" })).toBe(false);
        });

        it("is false for an ordinary string body that happens not to be the marker", () => {
            expect.assertions(1);

            expect(isLossyBody("just a plain string")).toBe(false);
        });
    });
});
