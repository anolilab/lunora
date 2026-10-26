import { afterEach, describe, expect, it, vi } from "vitest";

import { appendRequestLogEntry, emitRequestLogEvent, redactArgs } from "../src/request-log";
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

/** Unique per call, so only this test's own calls can fill the redaction memo for it. */
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

describe("emitRequestLogEvent sharing the append-path redaction", () => {
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

            appendRequestLogEntry(database.sql, entry);
            emitRequestLogEvent(entry);

            expect(maskCalls.count).toBe(2);
        } finally {
            log.mockRestore();
            database.close();
        }
    });

    it("emits what redacting on its own would, redacted and under captureRaw", () => {
        expect.assertions(4);

        const database = createSqliteExec();
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
            for (const captureRaw of [false, true]) {
                const entry = dispatch();

                appendRequestLogEntry(database.sql, entry, { captureRaw });
                emitRequestLogEvent(entry, { captureRaw });

                const event = JSON.parse(emittedLine(log)) as { args: unknown; identity: unknown };

                expect(JSON.stringify(event.args)).toBe(JSON.stringify(redactArgs(entry.redactedArgs, captureRaw)));
                expect(JSON.stringify(event.identity)).toBe(JSON.stringify(redactArgs(entry.identity, captureRaw)));
            }
        } finally {
            log.mockRestore();
            database.close();
        }
    });
});
