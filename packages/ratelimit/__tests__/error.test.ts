import { describe, expect, it } from "vitest";

import { RateLimitError } from "../src/error.js";

describe("rateLimitError", () => {
    it("describes a deny-list rejection", () => {
        expect.assertions(3);

        const error = new RateLimitError({ ok: false, reason: "deny", retryAfter: Number.POSITIVE_INFINITY });

        expect(error.name).toBe("RateLimitError");
        expect(error.reason).toBe("deny");
        expect(error.message).toBe("request denied (deny list)");
    });

    it("describes a rate rejection with a rounded retryAfter", () => {
        expect.assertions(3);

        const error = new RateLimitError({ ok: false, reason: "rate", retryAfter: 99.2 });

        expect(error.reason).toBe("rate");
        expect(error.retryAfter).toBe(99.2);
        expect(error.message).toBe("rate limit exceeded; retry after 100ms");
    });

    it("omits an unbounded retryAfter from the message", () => {
        expect.assertions(1);

        const error = new RateLimitError({ ok: false, reason: "rate", retryAfter: Number.POSITIVE_INFINITY });

        expect(error.message).toBe("rate limit exceeded");
    });

    it("honors an explicit message override", () => {
        expect.assertions(1);

        const error = new RateLimitError({ ok: false, reason: "rate", retryAfter: 100 }, "slow down");

        expect(error.message).toBe("slow down");
    });
});
