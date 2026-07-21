import { describe, expect, it } from "vitest";

import {
    ERROR_CATALOG,
    findSolutionByMessage,
    flattenHint,
    invariant,
    isInternalCode,
    isLunoraError,
    LunoraError,
    resolveHint,
    toErrorBody,
    unreachable,
} from "../src";

describe("lunoraError", () => {
    it("fills status/title/hint from the catalog by code", () => {
        expect.assertions(6);

        const error = new LunoraError("NOT_FOUND");

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("NOT_FOUND");
        expect(error.status).toBe(404);
        expect(error.name).toBe("LunoraError");
        // No message given → the code is the message; the title stays separate metadata.
        expect(error.message).toBe("NOT_FOUND");
        expect(error.title).toBe(ERROR_CATALOG.NOT_FOUND.title);
    });

    it("carries a catalog hint for CONFLICT", () => {
        expect.assertions(2);

        const error = new LunoraError("CONFLICT", "boom");

        expect(error.message).toBe("boom");
        expect(error.hint).toBe(ERROR_CATALOG.CONFLICT.hint);
    });

    it("lets options override status, name, hint, data, docsUrl", () => {
        expect.assertions(5);

        const error = new LunoraError("BAD_REQUEST", "bad", {
            data: { field: "email" },
            docsUrl: "https://lunora.sh/docs/errors",
            hint: "fix it",
            name: "ConflictError",
            status: 418,
        });

        expect(error.status).toBe(418);
        expect(error.name).toBe("ConflictError");
        expect(error.hint).toBe("fix it");
        expect(error.data).toStrictEqual({ field: "email" });
        expect(error.docsUrl).toBe("https://lunora.sh/docs/errors");
    });

    it("accepts a code outside the catalog (status defaults to 500)", () => {
        expect.assertions(2);

        const error = new LunoraError("SOME_PACKAGE_CODE", "custom", { status: 502 });

        expect(error.code).toBe("SOME_PACKAGE_CODE");
        expect(error.status).toBe(502);
    });

    it("rEGRESSION: does not install an own `cause` property when no cause is given", () => {
        expect.assertions(3);

        const error = new LunoraError("NOT_FOUND");

        // ES2022 InstallErrorCause keys off `HasProperty(options, "cause")`, so a
        // bare `{ cause: options.cause }` would install `cause: undefined` on
        // every error and make presence checks spuriously true.
        expect(Object.hasOwn(error, "cause")).toBe(false);
        expect("cause" in error).toBe(false);
        expect(error.cause).toBeUndefined();
    });

    it("rEGRESSION: installs an own `cause` when a cause is provided", () => {
        expect.assertions(2);

        const underlying = new Error("root");
        const error = new LunoraError("INTERNAL", "boom", { cause: underlying });

        expect(Object.hasOwn(error, "cause")).toBe(true);
        expect(error.cause).toBe(underlying);
    });

    it("exposes code/status/hint/data as own enumerable props (so they ride the wire codec)", () => {
        expect.assertions(4);

        const error = new LunoraError("CONFLICT", "boom", { data: { retryAfterMs: 10 } });
        const keys = Object.keys(error);

        expect(keys).toContain("code");
        expect(keys).toContain("status");
        expect(keys).toContain("hint");
        expect(keys).toContain("data");
    });
});

describe("isLunoraError", () => {
    it("matches a real LunoraError", () => {
        expect.assertions(1);

        expect(isLunoraError(new LunoraError("FORBIDDEN"))).toBe(true);
    });

    it("matches a wire-decoded twin (plain Error with brand + code + status)", () => {
        expect.assertions(1);

        // The wire codec copies all own enumerable props, including `type`,
        // so a decoded twin carries the brand.
        const twin = Object.assign(new Error("nope"), { code: "NOT_FOUND", status: 404, type: "VisulimaError" });

        expect(isLunoraError(twin)).toBe(true);
    });

    it("rejects a plain Error and non-errors", () => {
        expect.assertions(3);

        expect(isLunoraError(new Error("x"))).toBe(false);
        expect(isLunoraError({ code: "X", status: 1 })).toBe(false);
        expect(isLunoraError(undefined)).toBe(false);
    });
});

describe("isInternalCode", () => {
    it("flags the internal/redacted codes", () => {
        expect.assertions(5);

        expect(isInternalCode("INTERNAL")).toBe(true);
        expect(isInternalCode("INTERNAL_SERVER_ERROR")).toBe(true);
        expect(isInternalCode("RPC_FAILED")).toBe(true);
        expect(isInternalCode("ENV_INVALID")).toBe(true);
        expect(isInternalCode("AUTH_HEADERS_MISSING")).toBe(true);
    });

    it("does not flag client-safe codes", () => {
        expect.assertions(3);

        expect(isInternalCode("BAD_REQUEST")).toBe(false);
        expect(isInternalCode("CONFLICT")).toBe(false);
        expect(isInternalCode("NOT_FOUND")).toBe(false);
    });

    it("rEGRESSION: inherited Object.prototype keys are not treated as catalog codes", () => {
        expect.assertions(5);

        // The catalog is a plain object literal; a guarded lookup must return
        // `undefined` for inherited members instead of resolving to
        // `Object.prototype`'s value (e.g. the `constructor` function).
        expect(isInternalCode("constructor")).toBe(false);
        expect(isInternalCode("toString")).toBe(false);
        expect(isInternalCode("hasOwnProperty")).toBe(false);
        expect(resolveHint({ code: "constructor" })).toBeUndefined();
        expect(resolveHint({ code: "toString" })).toBeUndefined();
    });
});

describe("toErrorBody — REGRESSION: foreign errors must not ride the echo path", () => {
    it("does not echo a foreign error that merely has code+status (brand guard)", () => {
        expect.assertions(2);

        const foreign = Object.assign(new Error("internal driver detail: host=db-primary-1"), { code: "PROTOCOL_ERROR", status: 502 });
        const { body, redacted } = toErrorBody(foreign);

        expect(redacted).toBe(true);
        expect(body.message).not.toContain("db-primary-1");
    });
});

describe("toErrorBody", () => {
    it("echoes a non-internal LunoraError with message, hint, and docsUrl", () => {
        expect.assertions(6);

        const error = new LunoraError("CONFLICT", "stale", { docsUrl: "https://lunora.sh/docs/errors" });
        const { body, redacted, status } = toErrorBody(error);

        expect(redacted).toBe(false);
        expect(status).toBe(409);
        expect(body.code).toBe("CONFLICT");
        expect(body.message).toBe("stale");
        expect(body.hint).toBe(ERROR_CATALOG.CONFLICT.hint);
        expect(body.docsUrl).toBe("https://lunora.sh/docs/errors");
    });

    it("redacts an INTERNAL-coded LunoraError's message but keeps its status", () => {
        expect.assertions(5);

        const { body, redacted, status } = toErrorBody(new LunoraError("INTERNAL", "unknown table: users"), { redactedMessage: "internal error" });

        expect(redacted).toBe(true);
        expect(status).toBe(500);
        expect(body.code).toBe("INTERNAL");
        expect(body.message).toBe("internal error");
        expect(body.hint).toBeUndefined();
    });

    it("maps an unrecognized throw to the fallback code + redacted message", () => {
        expect.assertions(4);

        const { body, redacted, status } = toErrorBody(new Error("boom"), { fallbackCode: "RPC_FAILED", redactedMessage: "internal error" });

        expect(redacted).toBe(true);
        expect(status).toBe(500);
        expect(body.code).toBe("RPC_FAILED");
        expect(body.message).toBe("internal error");
    });

    it("wire-encodes `data` only when an encoder is passed", () => {
        expect.assertions(2);

        const error = new LunoraError("BAD_REQUEST", "bad", { data: { retryAfterMs: 10 } });

        expect(toErrorBody(error).body.data).toBeUndefined();
        expect(
            toErrorBody(error, {
                encodeData: (d) => {
                    return { encoded: d };
                },
            }).body.data,
        ).toStrictEqual({ encoded: { retryAfterMs: 10 } });
    });
});

describe("flattenHint", () => {
    it("drops code fences and strips bold/code emphasis", () => {
        expect.assertions(1);

        expect(flattenHint(["Use `ctx.db`", "```ts", "code", "```", "and **retry**"])).toBe("Use ctx.db\ncode\nand retry");
    });
});

describe("catalog message solutions", () => {
    it("finds the codegen missing-schema solution by message", () => {
        expect.assertions(1);

        const solution = findSolutionByMessage("defineSchema() not found in schema.ts");

        expect(solution?.id).toBe("lunora-schema-missing");
    });

    it("returns undefined for an unrecognized message", () => {
        expect.assertions(1);

        expect(findSolutionByMessage("totally unrelated")).toBeUndefined();
    });

    it("resolveHint prefers an explicit hint, then code, then message", () => {
        expect.assertions(3);

        expect(resolveHint({ hint: "explicit" })).toBe("explicit");
        expect(resolveHint({ code: "CONFLICT" })).toBe(ERROR_CATALOG.CONFLICT.hint);
        expect(resolveHint("optimistic concurrency conflict on row")).toBe(ERROR_CATALOG.CONFLICT.hint.join("\n"));
    });
});

describe("invariant / unreachable", () => {
    it("invariant throws an INTERNAL LunoraError when falsy", () => {
        expect.assertions(5);

        expect(() => {
            invariant(false, "nope");
        }).toThrow(LunoraError);

        let caught: unknown;

        try {
            invariant(0, "nope");
        } catch (error) {
            caught = error;
        }

        expect(isLunoraError(caught)).toBe(true);
        expect((caught as LunoraError).code).toBe("INTERNAL");
        expect((caught as LunoraError).status).toBe(500);
        expect((caught as Error).name).toBe("InvariantError");
    });

    it("invariant passes through when truthy", () => {
        expect.assertions(1);

        expect(() => {
            invariant(1, "ok");
        }).not.toThrow();
    });

    it("unreachable always throws INTERNAL", () => {
        expect.assertions(1);

        expect(() => unreachable("branch")).toThrow(LunoraError);
    });
});
