import { describe, expect, it } from "vitest";

import type { LoggedError } from "../../../shared/log-fields";
import { parseLoggedError } from "../../../shared/log-fields";
import { parseLogArgs, redactArgs } from "../src/request-log";

/** The `err` field of a structured `ctx.log` call, as normalized. */
const loggedField = (value: unknown): unknown => parseLogArgs(["failed", { err: value }]).fields?.err;

const parsed = (value: unknown): LoggedError => {
    const error = parseLoggedError(loggedField(value));

    if (error === undefined) {
        throw new Error(`not a logged error: ${String(loggedField(value))}`);
    }

    return error;
};

describe("an Error in ctx.log fields", () => {
    it("keeps name, message, stack and the cause chain", () => {
        expect.assertions(3);

        const cause = new Error("disk full");
        const error = parsed(new TypeError("save failed", { cause }));

        expect(error).toMatchObject({ cause: { message: "disk full", name: "Error" }, message: "save failed", name: "TypeError" });
        expect(error.stack).toContain("TypeError: save failed");
        expect((error.cause as LoggedError).stack).toBe(cause.stack);
    });

    it("keeps an Error nested inside an object field", () => {
        expect.assertions(1);

        const field = parseLogArgs(["failed", { attempt: { err: new Error("inner"), n: 2 } }]).fields?.attempt;

        expect(JSON.parse(String(field))).toMatchObject({ err: { message: "inner", name: "Error" }, n: 2 });
    });

    it("keeps an AggregateError's errors, capped at ten", () => {
        expect.assertions(2);

        const error = parsed(
            new AggregateError(
                Array.from({ length: 12 }, (_, index) => new Error(`member ${String(index)}`)),
                "all failed",
            ),
        );

        expect(error.errors).toHaveLength(10);
        expect(error.errors?.[0]).toMatchObject({ message: "member 0", name: "Error" });
    });

    it("cuts a cause cycle to the repeated Error's name and message", () => {
        expect.assertions(1);

        const looped = new Error("loop");

        looped.cause = looped;

        expect(parsed(looped).cause).toStrictEqual({ message: "loop", name: "Error" });
    });

    it("keeps four cause levels below the top Error and only the name and message of the next", () => {
        expect.assertions(2);

        const root = new Error("level 0");
        let current = root;

        for (let level = 1; level <= 6; level += 1) {
            const next = new Error(`level ${String(level)}`);

            current.cause = next;
            current = next;
        }

        let cause: unknown = parsed(root);

        for (let level = 1; level <= 4; level += 1) {
            cause = (cause as LoggedError).cause;
        }

        expect((cause as LoggedError).message).toBe("level 4");
        expect((cause as LoggedError).cause).toStrictEqual({ message: "level 5", name: "Error" });
    });

    it("cuts stacks so the field fits under the redaction cap and still parses after redaction", () => {
        expect.assertions(3);

        const frames = Array.from({ length: 80 }, (_, index) => `    at frame${String(index)} (some/long/path/to/a/module/file-${String(index)}.ts:1:1)`).join(
            "\n",
        );
        const cause = new Error("inner");
        const error = new Error("outer", { cause });

        cause.stack = `Error: inner\n${frames}`;
        error.stack = `Error: outer\n${frames}`;

        const field = String(loggedField(error));
        const redacted = parseLoggedError((redactArgs({ err: field }) as { err: string }).err);

        expect(field.length).toBeLessThanOrEqual(3584);
        expect(redacted?.message).toBe("outer");
        expect((redacted?.cause as LoggedError | undefined)?.message).toBe("inner");
    });

    it("stays parseable after redaction masks a credential in the message, the stack and the cause", () => {
        expect.assertions(3);

        const error = new Error("fetch https://api.example/v1?token=abc123 failed password=hunter2", { cause: new Error("Bearer abc.def.ghi") }); // gitleaks:allow -- test fixture, not a credential
        const field = (redactArgs({ err: loggedField(error) }) as { err: string }).err;
        const redacted = parseLoggedError(field);

        expect(redacted?.message).toBe("fetch https://api.example/v1 failed password=<REDACTED>");
        expect(field).not.toContain("hunter2");
        expect(field).not.toContain("abc.def.ghi");
    });

    it("leaves out the Error's own fields when they hold a cycle, and keeps its stack and cause", () => {
        expect.assertions(3);

        const error = new RangeError("too large", { cause: new Error("limit 100") }) as RangeError & { context?: unknown };
        const context: Record<string, unknown> = {};

        context.self = context;
        error.context = context;

        const logged = parsed(error);

        expect(logged).not.toHaveProperty("context");
        expect(logged.stack).toContain("RangeError: too large");
        expect(logged.cause).toMatchObject({ message: "limit 100" });
    });

    it.each([
        ["a `key: value` credential", "upstream rejected secret: s3cr3tvalue"],
        ["a URL with a query", "upstream rejected https://api.example/v1/charge?token=abc123"],
    ])("stays parseable after redaction with %s at the very end of the message", (_label, message) => {
        expect.assertions(2);

        const field = (redactArgs({ err: loggedField(new Error(message)) }) as { err: string }).err;

        expect(parseLoggedError(field)?.name).toBe("Error");
        expect(field).not.toMatch(/s3cr3tvalue|abc123/u);
    });

    it("does not read a plain { name, message } object as an Error", () => {
        expect.assertions(1);

        expect(parseLoggedError(loggedField({ message: "m", name: "n" }))).toBeUndefined();
    });
});
