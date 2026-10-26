import { afterEach, describe, expect, it, vi } from "vitest";

import { appendRequestLogEntry, emitRequestLogEvent } from "../src/request-log";
import createSqliteExec from "./_helpers/node-sqlite";

const { maskCalls } = vi.hoisted(() => {
    return { maskCalls: { count: 0 } };
});

// `maskCredentials` is the first step of every redaction pass, so its call count is the pass count.
vi.mock(import("../../../shared/credential-redaction"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        maskCredentials: (value: unknown) => {
            maskCalls.count += 1;

            return actual.maskCredentials(value);
        },
    };
});

/** Unique per call, so the append path's per-input memo never answers for it. */
const dispatch = () => {
    const unique = crypto.randomUUID();

    return {
        durationMs: 5,
        functionPath: "messages:list",
        identity: { email: `alice-${unique}@example.com`, subject: `user-${unique}` },
        outcome: "ok" as const,
        redactedArgs: { channel: `c-${unique}`, token: "s3cr3t" },
        ts: 1000,
    };
};

/** The last line written to `console.log`. */
const emittedLine = (log: ReturnType<typeof vi.spyOn>): string => String(log.mock.calls.at(-1)?.[0]);

describe("emitRequestLogEvent reusing the append-path redaction", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("redacts identity and args once across the durable write and the event", () => {
        expect.assertions(1);

        const database = createSqliteExec();
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
            const entry = dispatch();

            maskCalls.count = 0;

            const redacted = appendRequestLogEntry(database.sql, entry);

            emitRequestLogEvent(entry, {}, redacted);

            expect(maskCalls.count).toBe(2);
        } finally {
            log.mockRestore();
            database.close();
        }
    });

    it("emits the same bytes as redacting on its own, redacted and under captureRaw", () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
            for (const options of [{}, { captureRaw: true }]) {
                const entry = dispatch();

                emitRequestLogEvent(entry, options);

                const standalone = emittedLine(log);

                emitRequestLogEvent(entry, options, appendRequestLogEntry(database.sql, entry, options));

                expect(emittedLine(log)).toBe(standalone);
            }
        } finally {
            log.mockRestore();
            database.close();
        }
    });
});
