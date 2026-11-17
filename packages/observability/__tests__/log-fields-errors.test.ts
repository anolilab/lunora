import { describe, expect, it } from "vitest";

import type { LoggedError } from "../../../shared/log-fields";
import { coerceFieldValue, formatLoggedErrorFields, parseLoggedError, readLogFields } from "../../../shared/log-fields";
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

    it("leaves out only the cyclic reference in an Error's own fields, and keeps its stack and cause", () => {
        expect.assertions(3);

        const error = new RangeError("too large", { cause: new Error("limit 100") }) as RangeError & { context?: unknown };
        const context: Record<string, unknown> = {};

        context.self = context;
        error.context = context;

        const logged = parsed(error);

        expect(logged.context).toStrictEqual({});
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

    /** An Error whose stack is `lines` frames long, each about 120 characters. */
    const withLongStack = (message: string, lines = 60): Error => {
        const error = new Error(message);

        error.stack = [
            `Error: ${message}`,
            ...Array.from({ length: lines }, (_, index) => `    at frame${String(index)} (${"/very/long/path".repeat(6)}/file.ts:1:1)`),
        ].join("\n");

        return error;
    };

    it("fits a whole field holding several Errors under the redaction cap, not each Error on its own", () => {
        expect.assertions(2);

        // Each would fit alone with its stack cut short; eight of them together do not.
        const failures = Array.from({ length: 8 }, (_, index) => withLongStack(`failure ${String(index)}`));
        const field = coerceFieldValue({ failures }, "full") as string;

        expect(field.length).toBeLessThanOrEqual(3584);
        expect(() => JSON.parse(field) as unknown).not.toThrow();
    });

    it("writes the same Error in full each time an AggregateError holds it, not as a cycle", () => {
        expect.assertions(2);

        const shared = new TypeError("bad input");

        // Short, so the field fits with every stack kept and only the cycle handling decides.
        shared.stack = "TypeError: bad input\n    at parse (input.ts:1:1)";

        const logged = parsed(new AggregateError([shared, shared], "two failed"));
        const [first, second] = logged.errors as LoggedError[];

        expect(first?.stack).toContain("TypeError: bad input");
        expect(second?.stack).toContain("TypeError: bad input");
    });

    it("falls back to a string, not a throw, for a field whose getter throws", () => {
        expect.assertions(1);

        const field = {
            error: new Error("x"),
            get broken(): never {
                throw new Error("getter");
            },
        };

        expect(() => parseLogArgs(["failed", { field }])).not.toThrow();
    });

    it("scans a value full of references to itself once, not once per path", () => {
        expect.assertions(1);

        const node: Record<string, unknown> = {};

        for (let index = 0; index < 100; index += 1) {
            node[`k${String(index)}`] = node;
        }

        // No Error anywhere, so the scan has to look through every reference before it can say so.
        const started = performance.now();

        coerceFieldValue(node, "full");

        expect(performance.now() - started).toBeLessThan(1000);
    });

    it("keeps the Error when a cycle runs through a non-Error cause", () => {
        expect.assertions(2);

        const error = new Error("outer") as Error & { cause?: unknown };

        error.cause = { error };

        const logged = parsed(error);

        expect(logged.stack).toContain("Error: outer");
        // The way back to the outer Error is the cycle, cut to its name and message; the rest of the wrapper stays.
        expect(logged.cause).toStrictEqual({ error: { message: "outer", name: "Error" } });
    });

    it("writes an Error's headline even when it defines toJSON, so its stack stays out of a span attribute", () => {
        expect.assertions(1);

        class Exposing extends Error {
            public toJSON(): unknown {
                return { stack: this.stack };
            }
        }

        expect(coerceFieldValue({ err: new Exposing("leak") }, "headline")).toBe('{"err":"Error: leak"}');
    });

    it.each([
        ["one whose message alone fills the budget", 2000],
        ["one whose message is longer than the budget", 6000],
    ])("still reads as an Error after its stack is dropped: %s", (_label, length) => {
        expect.assertions(3);

        const field = loggedField(new Error("m".repeat(length))) as string;
        const logged = parseLoggedError(field);

        expect(field.length).toBeLessThanOrEqual(3584);
        expect(logged?.name).toBe("Error");
        expect(logged?.stack).toBe("");
    });

    it("masks a credential among an Error's own fields before it reaches the buffer and sinks", () => {
        expect.assertions(2);

        const error = new Error("request failed") as Error & { config?: unknown };

        error.config = { headers: { authorization: "placeholder-credential" }, url: "https://api.example/charge" };

        const field = loggedField(error) as string;

        expect(field).not.toContain("placeholder-credential");
        expect(parseLoggedError(field)?.message).toBe("request failed");
    });

    it("keeps an Error's own `__proto__` field as a field, not as the record's prototype", () => {
        expect.assertions(1);

        const error = new Error("proto");

        Object.defineProperty(error, "__proto__", { enumerable: true, value: { tenant: "acme" } });

        expect(Object.getOwnPropertyDescriptor(parsed(error), "__proto__")?.value).toStrictEqual({ tenant: "acme" });
    });

    it("lists an Error nested inside a field under its path, beside the field's text", () => {
        expect.assertions(3);

        const { fields } = parseLogArgs(["retrying", { attempt: { err: new TypeError("timeout"), number: 2 } }]);
        const read = readLogFields(fields);

        expect(read.errors.map(([path]) => path)).toStrictEqual(["attempt.err"]);
        expect(read.errors[0]?.[1].message).toBe("timeout");
        expect(read.text).toContain('attempt={"err":');
    });

    it("builds a headline from name and message, not from an Error's own toString", () => {
        expect.assertions(2);

        class Verbose extends Error {
            public override toString(): string {
                return `${this.name}: ${this.message}\n${String(this.stack)}`;
            }
        }

        const error = new Verbose("leak");

        expect(coerceFieldValue(error, "headline")).toBe("Error: leak");
        expect(coerceFieldValue({ err: error }, "headline")).toBe('{"err":"Error: leak"}');
    });

    it("cuts a large non-Error cause in the last mode, so the field still fits and parses", () => {
        expect.assertions(3);

        const field = loggedField(new Error("upstream", { cause: { body: "x".repeat(10_000) } })) as string;
        const logged = parseLoggedError(field);

        expect(field.length).toBeLessThanOrEqual(3584);
        expect(logged?.message).toBe("upstream");
        expect(String(logged?.cause).length).toBeLessThan(600);
    });

    it("encodes a field twice, not once per mode, when what is too large sits outside its Errors", () => {
        expect.assertions(1);

        let records = 0;

        coerceFieldValue({ err: new Error("x"), payload: "p".repeat(10_000) }, "full", (record) => {
            records += 1;

            return record;
        });

        // The full form, then the smallest: neither fits, and no stack cut between them could.
        expect(records).toBe(2);
    });

    it("does not read a plain { name, message } object as an Error", () => {
        expect.assertions(1);

        expect(parseLoggedError(loggedField({ message: "m", name: "n" }))).toBeUndefined();
    });
});

describe("formatLoggedErrorFields", () => {
    it("caps a cause chain of any depth instead of overflowing the stack", () => {
        expect.assertions(2);

        let chain: LoggedError = { message: "root", name: "Error", stack: "" };

        for (let index = 0; index < 100_000; index += 1) {
            chain = { cause: chain, message: `level ${String(index)}`, name: "Error", stack: "" };
        }

        const text = formatLoggedErrorFields([["err", chain]]);

        expect(text).toContain("level 99999");
        expect(text.split("\n").length).toBeLessThan(20);
    });

    const detail = (error: Error): string => formatLoggedErrorFields(readLogFields(parseLogArgs(["failed", { err: error }]).fields).errors);

    it("heads each error with its current name, even when the stack was built under another", () => {
        expect.assertions(1);

        const error = new Error("card declined");

        error.stack = "Error: card declined\n    at charge (pay.ts:3:9)";
        error.name = "PaymentError";

        expect(detail(error)).toBe(["err: PaymentError: card declined", "    at charge (pay.ts:3:9)"].join("\n"));
    });

    it("indents frames of a stack in another engine's format, which has no header", () => {
        expect.assertions(1);

        const cause = new Error("disk full");
        const error = new Error("save failed", { cause });

        error.stack = "save@orders.ts:4:11\nplace@orders.ts:9:3";
        cause.stack = "write@store.ts:9:3";

        expect(detail(error)).toBe(
            ["err: Error: save failed", "    save@orders.ts:4:11", "    place@orders.ts:9:3", "  caused by: Error: disk full", "      write@store.ts:9:3"].join(
                "\n",
            ),
        );
    });

    it("strips a bare-name header from an Error with an empty message", () => {
        expect.assertions(1);

        // eslint-disable-next-line unicorn/error-message -- the empty message is the case under test
        const error = new TypeError("");

        error.stack = "TypeError\n    at run (job.ts:1:1)";

        expect(detail(error)).toBe(["err: TypeError", "    at run (job.ts:1:1)"].join("\n"));
    });
});
