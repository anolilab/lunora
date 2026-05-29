import { describe, expect, test } from "vitest";

import { RateLimitError } from "../src/error.js";

describe("rateLimitError", () => {
    test("describes a deny-list rejection", () => {
        const error = new RateLimitError({ ok: false, reason: "deny", retryAfter: Number.POSITIVE_INFINITY });

        expect(error.name).toBe("RateLimitError");
        expect(error.reason).toBe("deny");
        expect(error.message).toBe("request denied (deny list)");
    });

    test("describes a rate rejection with a rounded retryAfter", () => {
        const error = new RateLimitError({ ok: false, reason: "rate", retryAfter: 99.2 });

        expect(error.reason).toBe("rate");
        expect(error.retryAfter).toBe(99.2);
        expect(error.message).toBe("rate limit exceeded; retry after 100ms");
    });

    test("omits an unbounded retryAfter from the message", () => {
        const error = new RateLimitError({ ok: false, reason: "rate", retryAfter: Number.POSITIVE_INFINITY });

        expect(error.message).toBe("rate limit exceeded");
    });

    test("honors an explicit message override", () => {
        const error = new RateLimitError({ ok: false, reason: "rate", retryAfter: 100 }, "slow down");

        expect(error.message).toBe("slow down");
    });
});
