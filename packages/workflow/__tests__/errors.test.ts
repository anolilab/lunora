import { describe, expect, it } from "vitest";

import { convertNonRetryableError, isNonRetryableError, NonRetryableError, toNativeNonRetryableError } from "../src/errors";

describe("nonRetryableError", () => {
    it("fixes the error name so the Workers SDK honors it", () => {
        expect.assertions(3);

        const error = new NonRetryableError("nope");

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("NonRetryableError");
        expect(error.message).toBe("nope");
    });

    it("accepts a custom name (Cloudflare parity)", () => {
        expect.assertions(1);

        expect(new NonRetryableError("nope", "FatalError").name).toBe("FatalError");
    });
});

describe("isNonRetryableError", () => {
    it("matches portable instances and rejects plain errors", () => {
        expect.assertions(4);

        expect(isNonRetryableError(new NonRetryableError("x"))).toBe(true);
        expect(isNonRetryableError(new Error("x"))).toBe(false);
        expect(isNonRetryableError("x")).toBe(false);
        expect(isNonRetryableError(null)).toBe(false);
    });
});

class FakeNativeNonRetryableError extends Error {
    public constructor(message: string, name = "NonRetryableError") {
        super(message);
        this.name = name;
    }
}

describe("toNativeNonRetryableError", () => {
    it("rebuilds the native error preserving name, message, and stack", () => {
        expect.assertions(4);

        const portable = new NonRetryableError("boom", "FatalError");
        const native = toNativeNonRetryableError(portable, FakeNativeNonRetryableError);

        expect(native).toBeInstanceOf(FakeNativeNonRetryableError);
        expect(native.name).toBe("FatalError");
        expect(native.message).toBe("boom");
        expect(native.stack).toBe(portable.stack);
    });

    it("copies the cause across when the portable error carries one", () => {
        expect.assertions(1);

        const cause = new Error("root cause");
        const portable = new NonRetryableError("boom");

        portable.cause = cause;

        const native = toNativeNonRetryableError(portable, FakeNativeNonRetryableError);

        expect(native.cause).toBe(cause);
    });
});

describe("convertNonRetryableError", () => {
    it("rethrows a portable NonRetryableError as the native one when a constructor is given", () => {
        expect.assertions(1);

        const portable = new NonRetryableError("boom");

        expect(() => convertNonRetryableError(portable, FakeNativeNonRetryableError)).toThrow(FakeNativeNonRetryableError);
    });

    it("rethrows the portable error unchanged when no native constructor is available (Node)", () => {
        expect.assertions(1);

        const portable = new NonRetryableError("boom");

        expect(() => convertNonRetryableError(portable, undefined)).toThrow(portable);
    });

    it("rethrows non-NonRetryableErrors unchanged", () => {
        expect.assertions(1);

        const ordinary = new Error("regular");

        expect(() => convertNonRetryableError(ordinary, FakeNativeNonRetryableError)).toThrow(ordinary);
    });
});
