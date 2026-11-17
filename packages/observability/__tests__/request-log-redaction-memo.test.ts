import { describe, expect, it, vi } from "vitest";

import { maskCredentials } from "../../../shared/credential-redaction";
import { appendRequestLogEntry, readRequestLog, redactArgs } from "../src/request-log";
import createSqliteExec from "./_helpers/node-sqlite";

vi.mock(import("../../../shared/credential-redaction"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, maskCredentials: vi.fn<typeof actual.maskCredentials>(actual.maskCredentials) };
});

const entry = (redactedArgs: unknown): Parameters<typeof appendRequestLogEntry>[1] => {
    return { durationMs: 5, functionPath: "messages:list", outcome: "ok", redactedArgs, ts: 1000 };
};

/** Log every value, then read back each row's stored args in order. */
const logAll = (values: ReadonlyArray<unknown>, options?: Parameters<typeof appendRequestLogEntry>[2]): unknown[] => {
    const database = createSqliteExec();

    try {
        for (const value of values) {
            appendRequestLogEntry(database.sql, entry(value), options);
        }

        return readRequestLog(database.sql)
            .toSorted((a, b) => a.seq - b.seq)
            .map((row) => row.redactedArgs);
    } finally {
        database.close();
    }
};

/** What the uncached path stores for `value`. */
const stored = (value: unknown): unknown => {
    const text = JSON.stringify(redactArgs(value));

    return JSON.parse(text) as unknown;
};

describe("request-log redaction memo", () => {
    it("redacts a repeated small value once, and a large or raw one every time", () => {
        expect.assertions(3);

        const args = { channelId: "memo-reuse", password: "hunter2" };

        vi.mocked(maskCredentials).mockClear();
        logAll([args, { ...args }, { ...args }]);

        expect(maskCredentials).toHaveBeenCalledTimes(1);

        const large = { note: "n".repeat(5000), password: "memo-large" };

        vi.mocked(maskCredentials).mockClear();
        logAll([large, large]);

        expect(maskCredentials).toHaveBeenCalledTimes(2);

        vi.mocked(maskCredentials).mockClear();
        logAll([args, args], { captureRaw: true });

        expect(maskCredentials).not.toHaveBeenCalled();
    });

    it("does not remember a value whose escaped text outgrows the cap the walk charged it under", () => {
        expect.assertions(2);

        // 300 characters to the walk, six times that once `JSON.stringify` escapes them.
        const escaped = { note: "\u0001".repeat(300) };

        expect(JSON.stringify(escaped).length).toBeGreaterThan(1024);

        vi.mocked(maskCredentials).mockClear();
        logAll([escaped, { ...escaped }]);

        expect(maskCredentials).toHaveBeenCalledTimes(2);
    });

    it("never shares a memo entry between an array with a toJSON and the object its JSON matches", () => {
        expect.assertions(2);

        const object = { password: "memo-tojson" };
        const array = Object.assign(["visible"], { toJSON: () => object });

        // Both orders: whichever is logged first must not answer for the other.
        expect(logAll([array, object])).toStrictEqual([stored(array), stored(object)]);
        expect(logAll([object, array])).toStrictEqual([stored(object), stored(array)]);
    });

    it("redacts a value with a getter on its own, even when its text matches a cached one", () => {
        expect.assertions(1);

        // The getter answers the same text as the plain value, so its memo key would
        // match; a getter is free to answer differently once the redactor reads it.
        const plain = { note: "memo-getter" };
        const withGetter = {
            get note(): string {
                return "memo-getter";
            },
        };

        vi.mocked(maskCredentials).mockClear();
        logAll([plain, withGetter]);

        expect(maskCredentials).toHaveBeenCalledTimes(2);
    });
});
