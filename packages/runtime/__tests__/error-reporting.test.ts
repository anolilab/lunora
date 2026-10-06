import { describe, expect, it } from "vitest";

import { parseStackFrames, toError } from "../src/error-reporting";

const STACK = ["TypeError: db down", "    at load (src/server/index.js:12:5)", "    at Array.map (<anonymous>)", "    at src/server/index.js:40:9"].join("\n");

describe(toError, () => {
    it("rebuilds a throwable carrying the original name, message, stack and code", () => {
        expect.assertions(4);

        const error = toError({ code: "INTERNAL_SERVER_ERROR", message: "db down", name: "TypeError", stack: STACK }) as Error & { code?: string };

        expect(error.name).toBe("TypeError");
        expect(error.message).toBe("db down");
        expect(error.stack).toBe(STACK);
        expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    });

    it("falls back to the code for the name when the event has none", () => {
        expect.assertions(1);

        expect(toError({ code: "CONFLICT", message: "write conflict" }).name).toBe("CONFLICT");
    });
});

describe(parseStackFrames, () => {
    it("parses V8 lines oldest call first, skipping lines without a location", () => {
        expect.assertions(1);

        expect(parseStackFrames(STACK)).toStrictEqual([
            { colno: 9, filename: "src/server/index.js", function: "<anonymous>", lineno: 40 },
            { colno: 5, filename: "src/server/index.js", function: "load", lineno: 12 },
        ]);
    });

    it("returns no frames for an absent stack", () => {
        expect.assertions(1);

        expect(parseStackFrames(undefined)).toStrictEqual([]);
    });
});
