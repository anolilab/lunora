import { afterEach, describe, expect, it, vi } from "vitest";

import { createDroppedTraceNotice, resolveTraceTrust } from "../src/trace-trust";

/** A request carrying an optional Cloudflare `cf` bag. */
const requestWith = (headers: Record<string, string> = {}, cf?: unknown): Request => {
    const request = new Request("https://app.example/_lunora/rpc", { headers, method: "POST" });

    if (cf !== undefined) {
        Object.defineProperty(request, "cf", { value: cf, writable: false });
    }

    return request;
};

describe("resolveTraceTrust", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ["undefined (the default)", undefined],
        ["an explicit false", false],
    ])("distrusts every caller for %s", (_label, option) => {
        expect.assertions(1);

        expect(resolveTraceTrust(option)(requestWith())).toBe(false);
    });

    it("trusts every caller for true", () => {
        expect.assertions(1);

        expect(resolveTraceTrust(true)(requestWith())).toBe(true);
    });

    describe("mtls", () => {
        it("trusts a caller whose certificate Cloudflare verified", () => {
            expect.assertions(1);

            expect(resolveTraceTrust("mtls")(requestWith({}, { tlsClientAuth: { certVerified: "SUCCESS" } }))).toBe(true);
        });

        it.each([
            ["a failed verification", { tlsClientAuth: { certVerified: "FAILED" } }],
            ["no client auth at all", { colo: "SFO" }],
            ["a non-object cf bag", "nonsense"],
        ])("distrusts %s", (_label, cf) => {
            expect.assertions(1);

            expect(resolveTraceTrust("mtls")(requestWith({}, cf))).toBe(false);
        });

        // Off Cloudflare there is no `cf` bag; the signal must read as absent
        // rather than throw on the dispatch path.
        it("distrusts a request with no cf bag", () => {
            expect.assertions(1);

            expect(resolveTraceTrust("mtls")(requestWith())).toBe(false);
        });

        // A header cannot forge this one — that is the whole point of preferring it.
        it("cannot be spoofed by a header", () => {
            expect.assertions(1);

            expect(resolveTraceTrust("mtls")(requestWith({ "cf-tls-client-auth": "SUCCESS" }))).toBe(false);
        });
    });

    describe("cloudflare-access", () => {
        it("trusts a request carrying an Access assertion", () => {
            expect.assertions(1);

            expect(resolveTraceTrust("cloudflare-access")(requestWith({ "cf-access-jwt-assertion": "ey.j.w.t" }))).toBe(true);
        });

        it("distrusts a request without one", () => {
            expect.assertions(1);

            expect(resolveTraceTrust("cloudflare-access")(requestWith())).toBe(false);
        });
    });

    describe("a list of signals", () => {
        it("trusts when any listed signal matches", () => {
            expect.assertions(2);

            const trusted = resolveTraceTrust(["mtls", "cloudflare-access"]);

            expect(trusted(requestWith({ "cf-access-jwt-assertion": "ey.j.w.t" }))).toBe(true);
            expect(trusted(requestWith({}, { tlsClientAuth: { certVerified: "SUCCESS" } }))).toBe(true);
        });

        it("distrusts when none match", () => {
            expect.assertions(1);

            expect(resolveTraceTrust(["mtls", "cloudflare-access"])(requestWith())).toBe(false);
        });

        it("distrusts an empty list rather than defaulting open", () => {
            expect.assertions(1);

            expect(resolveTraceTrust([])(requestWith())).toBe(false);
        });
    });

    it("uses a custom predicate verbatim", () => {
        expect.assertions(2);

        const trusted = resolveTraceTrust((request) => request.headers.get("x-internal") === "1");

        expect(trusted(requestWith({ "x-internal": "1" }))).toBe(true);
        expect(trusted(requestWith({ "x-internal": "0" }))).toBe(false);
    });
});

describe("createDroppedTraceNotice", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Silence is what costs an afternoon: the waterfall is broken with nothing to
    // search for. Fire once, so it is a hint rather than per-request noise.
    it("warns once and only once when the option was never set", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const notice = createDroppedTraceNotice(undefined);

        notice();
        notice();
        notice();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain("trustInboundTraceContext");
    });

    it.each([
        ["false", false as const],
        ["true", true as const],
        ["a signal", "mtls" as const],
    ])("stays silent once the option is set to %s", (_label, option) => {
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        createDroppedTraceNotice(option)();

        expect(warn).not.toHaveBeenCalled();
    });
});
