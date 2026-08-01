import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { isLoopbackAddress, transportRejectionReason } from "../../src/studio-host/transport-guard";

/* eslint-disable sonarjs/no-hardcoded-ip -- intentional test fixtures asserting the loopback/rebinding guard's classification; no real connection is made */

/** A request shape rich enough for the guard: `headers` + a socket peer. */
const request = (input: { headers?: Record<string, string>; remoteAddress?: string }): IncomingMessage =>
    ({ headers: input.headers ?? {}, socket: { remoteAddress: input.remoteAddress } }) as unknown as IncomingMessage;

describe("isLoopbackAddress", () => {
    it("accepts IPv4/IPv6 loopback and IPv4-mapped forms", () => {
        expect.assertions(4);

        expect(isLoopbackAddress("127.0.0.1")).toBe(true);
        expect(isLoopbackAddress("::1")).toBe(true);
        expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
        expect(isLoopbackAddress("127.5.5.5")).toBe(true);
    });

    it("rejects a non-loopback peer", () => {
        expect.assertions(1);

        expect(isLoopbackAddress("203.0.113.7")).toBe(false);
    });

    it("treats a missing address as loopback (mocked/partial transports)", () => {
        expect.assertions(2);

        expect(isLoopbackAddress(undefined)).toBe(true);
        expect(isLoopbackAddress("")).toBe(true);
    });
});

describe("transportRejectionReason", () => {
    it("passes a loopback socket peer with a localhost Host", () => {
        expect.assertions(1);

        expect(transportRejectionReason(request({ headers: { host: "localhost:5173" }, remoteAddress: "127.0.0.1" }))).toBeUndefined();
    });

    it("passes a loopback socket peer with an absent Host header (HTTP/1.0)", () => {
        expect.assertions(1);

        // Deliberate delta from the CLI host's prior standalone guard, which
        // rejected an absent Host outright: with the socket-peer check in
        // front, an absent Host is a local non-browser client — browsers (the
        // only DNS-rebinding vector) always send Host.
        expect(transportRejectionReason(request({ headers: {}, remoteAddress: "127.0.0.1" }))).toBeUndefined();
    });

    it("passes a loopback socket peer with a 0.0.0.0 Host literal", () => {
        expect.assertions(1);

        // Only reachable when the socket peer is already loopback; harmless
        // under the socket gate, and some platforms let a browser navigate to
        // `http://0.0.0.0:<port>` which connects to loopback.
        expect(transportRejectionReason(request({ headers: { host: "0.0.0.0:5173" }, remoteAddress: "127.0.0.1" }))).toBeUndefined();
    });

    it("rejects a non-loopback socket peer", () => {
        expect.assertions(1);

        expect(transportRejectionReason(request({ headers: { host: "localhost:5173" }, remoteAddress: "203.0.113.7" }))).toBe(
            "Lunora studio is only available on loopback connections in dev.",
        );
    });

    it("rejects a non-localhost Host header on a loopback peer (DNS rebinding)", () => {
        expect.assertions(1);

        expect(transportRejectionReason(request({ headers: { host: "evil.example.com" }, remoteAddress: "127.0.0.1" }))).toBe(
            "Lunora studio rejects a non-localhost Host header in dev.",
        );
    });

    it.each(["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"])(
        "rejects a proxied request carrying %s on a loopback peer",
        (forwardingHeader) => {
            expect.assertions(1);

            expect(
                transportRejectionReason(
                    request({ headers: { host: "localhost:5173", [forwardingHeader]: "203.0.113.7" }, remoteAddress: "127.0.0.1" }),
                ),
            ).toBe("Lunora studio refuses a proxied (X-Forwarded-*) request in dev.");
        },
    );
});
