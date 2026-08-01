import type { IncomingMessage } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ALLOW_FORWARDED_ENV, isLoopbackAddress, transportRejectionReason } from "../../src/studio-host/transport-guard";

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
        "rejects a proxied request carrying %s on a loopback peer, naming the header",
        (forwardingHeader) => {
            expect.assertions(1);

            const reason = transportRejectionReason(
                request({ headers: { host: "localhost:5173", [forwardingHeader]: "203.0.113.7" }, remoteAddress: "127.0.0.1" }),
            );

            // The header name and the escape hatch are both named in the reason,
            // so the failure points at its cause instead of an opaque 403.
            expect(reason).toBe(
                `Lunora studio refuses a proxied request in dev (saw the "${forwardingHeader}" header). ` +
                    `If you're intentionally running behind a trusted dev tunnel/proxy (e.g. Codespaces, devcontainers, Gitpod, ngrok), ` +
                    `set ${ALLOW_FORWARDED_ENV}=1 to allow it.`,
            );
        },
    );

    it("logs a warnOnce naming the header and the escape hatch when a logger is supplied", () => {
        expect.assertions(2);

        const warnOnce = vi.fn<(message: string) => void>();

        const reason = transportRejectionReason(
            request({ headers: { host: "localhost:5173", "x-forwarded-for": "203.0.113.7" }, remoteAddress: "127.0.0.1" }),
            { warnOnce },
        );

        expect(reason).toBeDefined();
        expect(warnOnce).toHaveBeenCalledWith(expect.stringContaining(`"x-forwarded-for"`));
    });

    it("does not log when there is nothing to reject", () => {
        expect.assertions(1);

        const warnOnce = vi.fn<(message: string) => void>();

        transportRejectionReason(request({ headers: { host: "localhost:5173" }, remoteAddress: "127.0.0.1" }), { warnOnce });

        expect(warnOnce).not.toHaveBeenCalled();
    });

    describe(`${ALLOW_FORWARDED_ENV} escape hatch`, () => {
        const original = process.env[ALLOW_FORWARDED_ENV];

        afterEach(() => {
            if (original === undefined) {
                Reflect.deleteProperty(process.env, ALLOW_FORWARDED_ENV);
            } else {
                process.env[ALLOW_FORWARDED_ENV] = original;
            }
        });

        it("permits a forwarded request from a loopback peer once set to 1 (Codespaces/devcontainers/Gitpod/ngrok/etc.)", () => {
            expect.assertions(1);

            process.env[ALLOW_FORWARDED_ENV] = "1";

            expect(
                transportRejectionReason(
                    request({ headers: { host: "localhost:5173", "x-forwarded-for": "203.0.113.7" }, remoteAddress: "127.0.0.1" }),
                ),
            ).toBeUndefined();
        });

        it("does not relax the socket-peer or Host checks — only the forwarding-header refusal", () => {
            expect.assertions(2);

            process.env[ALLOW_FORWARDED_ENV] = "1";

            expect(
                transportRejectionReason(
                    request({ headers: { host: "localhost:5173", "x-forwarded-for": "203.0.113.7" }, remoteAddress: "203.0.113.7" }),
                ),
            ).toBe("Lunora studio is only available on loopback connections in dev.");
            expect(
                transportRejectionReason(
                    request({ headers: { host: "evil.example.com", "x-forwarded-for": "203.0.113.7" }, remoteAddress: "127.0.0.1" }),
                ),
            ).toBe("Lunora studio rejects a non-localhost Host header in dev.");
        });

        it("any other value (including unset) keeps refusing the forwarded request", () => {
            expect.assertions(2);

            process.env[ALLOW_FORWARDED_ENV] = "true";

            expect(
                transportRejectionReason(
                    request({ headers: { host: "localhost:5173", "x-forwarded-for": "203.0.113.7" }, remoteAddress: "127.0.0.1" }),
                ),
            ).toBeDefined();

            Reflect.deleteProperty(process.env, ALLOW_FORWARDED_ENV);

            expect(
                transportRejectionReason(
                    request({ headers: { host: "localhost:5173", "x-forwarded-for": "203.0.113.7" }, remoteAddress: "127.0.0.1" }),
                ),
            ).toBeDefined();
        });
    });
});
