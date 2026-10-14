import { describe, expect, it } from "vitest";

import { convertNonRetryableError, isDuplicateInstanceError, isNonRetryableError, NonRetryableError, toNativeNonRetryableError } from "../src/errors";

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

describe("isDuplicateInstanceError", () => {
    it("recognises the separator variants a duplicate-id rejection can spell", () => {
        expect.assertions(6);

        // This predicate is the idempotency signal the fan-out spawn and
        // `@lunora/agent`'s sub-agent/channel dispatch both key on: a create that
        // rejects this way already applied, so the caller attaches instead of
        // burning its retries. It cannot be pinned against a live engine here —
        // miniflare's `WorkflowBinding.create` never rejects a duplicate at all
        // (it calls `stub.init(...)` unconditionally, and `Engine.init` returns
        // early for an instance that already has metadata), so the attach branch
        // is unreachable under workerd too. What IS in our control is not being
        // defeated by the separator, which is what this pins.
        expect(isDuplicateInstanceError(new Error('instance with id "x" already exists'))).toBe(true);
        expect(isDuplicateInstanceError(new Error("instance.already-exists"))).toBe(true);
        expect(isDuplicateInstanceError(new Error("instance.already_exists"))).toBe(true);
        expect(isDuplicateInstanceError("Instance AlreadyExists")).toBe(true);
        expect(isDuplicateInstanceError(new Error("Workflows service unavailable"))).toBe(false);
        // The other deterministic `create` rejection — never an attach signal.
        expect(isDuplicateInstanceError(new Error("Workflow instance has invalid id"))).toBe(false);
    });
});
