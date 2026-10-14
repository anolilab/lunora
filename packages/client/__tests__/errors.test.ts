import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { CONFLICT_ERROR_CODE, getErrorCode, getRetryAfterMs, isConflictError, isForbiddenError, isRateLimitedError, isUnauthorizedError } from "../src/errors";

/** Build an `Error` carrying the machine-readable `code` the client attaches when decoding the worker envelope. */
const errorWithCode = (code: string): LunoraError => new LunoraError(code, "boom");

describe("isConflictError", () => {
    it("exposes CONFLICT_ERROR_CODE as the server's 409 code", () => {
        expect.assertions(1);

        expect(CONFLICT_ERROR_CODE).toBe("CONFLICT");
    });

    it("a coded Error with code CONFLICT is a conflict", () => {
        expect.assertions(1);

        const error = new LunoraError("CONFLICT", "optimistic concurrency conflict");

        expect(isConflictError(error)).toBe(true);
    });

    it("a coded Error with a different code is not a conflict", () => {
        expect.assertions(1);

        const error = new LunoraError("NOT_FOUND", "missing");

        expect(isConflictError(error)).toBe(false);
    });

    it("a plain Error with no code is not a conflict", () => {
        expect.assertions(1);

        expect(isConflictError(new Error("boom"))).toBe(false);
    });

    it("non-Error values are not conflicts", () => {
        expect.assertions(3);

        expect(isConflictError(undefined)).toBe(false);
        expect(isConflictError("CONFLICT")).toBe(false);
        expect(isConflictError({ code: "CONFLICT", message: "not an Error" })).toBe(false);
    });
});

describe("error discriminators", () => {
    it("isForbiddenError narrows an RLS/policy denial", () => {
        expect.assertions(4);

        expect(isForbiddenError(errorWithCode("FORBIDDEN"))).toBe(true);
        expect(isForbiddenError(errorWithCode("UNAUTHORIZED"))).toBe(false);
        // A plain object is not an `Error` — the type predicate fails closed.
        expect(isForbiddenError({ code: "FORBIDDEN" })).toBe(false);
        expect(isForbiddenError(null)).toBe(false);
    });

    it("isUnauthorizedError narrows an auth failure", () => {
        expect.assertions(3);

        expect(isUnauthorizedError(errorWithCode("UNAUTHORIZED"))).toBe(true);
        expect(isUnauthorizedError(errorWithCode("FORBIDDEN"))).toBe(false);
        expect(isUnauthorizedError(undefined)).toBe(false);
    });

    it("isRateLimitedError narrows a rate-limit denial", () => {
        expect.assertions(3);

        expect(isRateLimitedError(errorWithCode("TOO_MANY_REQUESTS"))).toBe(true);
        expect(isRateLimitedError(errorWithCode("CONFLICT"))).toBe(false);
        expect(isRateLimitedError("nope")).toBe(false);
    });
});

describe("getErrorCode", () => {
    it("returns the union member for a known code", () => {
        expect.assertions(2);

        expect(getErrorCode(errorWithCode("FORBIDDEN"))).toBe("FORBIDDEN");
        expect(getErrorCode(errorWithCode("TOO_MANY_REQUESTS"))).toBe("TOO_MANY_REQUESTS");
    });

    it("returns undefined for an unrecognized code, a missing code, and a non-Error", () => {
        expect.assertions(4);

        expect(getErrorCode(errorWithCode("SOMETHING_ELSE"))).toBeUndefined();
        expect(getErrorCode(new Error("no code"))).toBeUndefined();
        // A plain object with a valid-looking code is not an `Error`.
        expect(getErrorCode({ code: "FORBIDDEN" })).toBeUndefined();
        expect(getErrorCode(null)).toBeUndefined();
    });
});

describe("getRetryAfterMs", () => {
    it("reads a finite data.retryAfterMs without hand-casting the payload", () => {
        expect.assertions(2);

        expect(getRetryAfterMs({ data: { retryAfterMs: 1500 } })).toBe(1500);
        // Works off a real reconstructed error too, not just a plain object.
        expect(getRetryAfterMs(new LunoraError("TOO_MANY_REQUESTS", "slow down", { data: { retryAfterMs: 250 } }))).toBe(250);
    });

    it("returns undefined when absent or non-numeric", () => {
        expect.assertions(5);

        expect(getRetryAfterMs({ data: {} })).toBeUndefined();
        expect(getRetryAfterMs({ data: { retryAfterMs: "1500" } })).toBeUndefined();
        expect(getRetryAfterMs({ data: { retryAfterMs: Number.POSITIVE_INFINITY } })).toBeUndefined();
        expect(getRetryAfterMs(new Error("no data"))).toBeUndefined();
        expect(getRetryAfterMs(null)).toBeUndefined();
    });
});
