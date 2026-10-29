import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IN_FLIGHT_CLAIM_CEILING_MS, InFlightClaims } from "../src/in-flight-claims";

describe(InFlightClaims, () => {
    const start = 1_700_000_000_000;
    let claims: InFlightClaims;

    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(start);
        claims = new InFlightClaims();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("declines a second claim of a live key, and admits it again once released", () => {
        expect.assertions(3);

        const first = claims.claim("system:", "job-1");

        expect(first).toMatchObject({ claimedAt: start });
        expect(claims.claim("system:", "job-1")).toBe("declined");

        claims.release(first as Exclude<typeof first, "declined" | undefined>);

        expect(claims.claim("system:", "job-1")).toMatchObject({ claimedAt: start });
    });

    it("fails open: no namespace means no claim and no decline", () => {
        expect.assertions(2);

        expect(claims.claim(undefined, "job-1")).toBeUndefined();
        expect(claims.claim(undefined, "job-1")).toBeUndefined();
    });

    it("keys on namespace AND id, NUL-separated so a split point cannot collide", () => {
        expect.assertions(3);

        claims.claim("u:", "x");

        // `"u:" + ":x"` and `"u::" + "x"` concatenate identically without a separator.
        expect(claims.claim("u::", "x")).not.toBe("declined");
        expect(claims.claim("u:", ":x")).not.toBe("declined");
        expect(claims.claim("u:", "x")).toBe("declined");
    });

    it("treats a claim as stale at the ceiling, not before", () => {
        expect.assertions(2);

        claims.claim("system:", "job-1");

        vi.mocked(Date.now).mockReturnValue(start + IN_FLIGHT_CLAIM_CEILING_MS - 1);

        expect(claims.claim("system:", "job-1")).toBe("declined");

        vi.mocked(Date.now).mockReturnValue(start + IN_FLIGHT_CLAIM_CEILING_MS);

        expect(claims.claim("system:", "job-1")).toMatchObject({ claimedAt: start + IN_FLIGHT_CLAIM_CEILING_MS });
    });

    it("a superseded holder settling late does not free its successor's claim", () => {
        expect.assertions(2);

        const hung = claims.claim("system:", "job-1") as Exclude<ReturnType<InFlightClaims["claim"]>, "declined" | undefined>;

        vi.mocked(Date.now).mockReturnValue(start + IN_FLIGHT_CLAIM_CEILING_MS);

        const successor = claims.claim("system:", "job-1");

        expect(successor).not.toBe("declined");

        // The hung handler finally settles and its `finally` releases.
        claims.release(hung);

        expect(claims.claim("system:", "job-1")).toBe("declined");
    });
});
