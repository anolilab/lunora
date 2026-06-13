import { describe, expect, it } from "vitest";

import { CONFLICT_ERROR_CODE, isConflictError } from "../src/errors";

describe("isConflictError", () => {
    it("exposes CONFLICT_ERROR_CODE as the server's 409 code", () => {
        expect.assertions(1);

        expect(CONFLICT_ERROR_CODE).toBe("CONFLICT");
    });

    it("a coded Error with code CONFLICT is a conflict", () => {
        expect.assertions(1);

        const error = Object.assign(new Error("optimistic concurrency conflict"), { code: "CONFLICT" });

        expect(isConflictError(error)).toBe(true);
    });

    it("a coded Error with a different code is not a conflict", () => {
        expect.assertions(1);

        const error = Object.assign(new Error("missing"), { code: "NOT_FOUND" });

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
