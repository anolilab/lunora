import type { networkInterfaces } from "node:os";

import { describe, expect, it } from "vitest";

import { hasIpv6Loopback } from "../../src/util/loopback";

type Interfaces = ReturnType<typeof networkInterfaces>;
type Address = NonNullable<Interfaces[string]>[number];

/** Minimal interface-address entry — only `address`/`internal` drive the check. */
const address = (value: string, internal: boolean): Address =>
    ({ address: value, cidr: null, family: value.includes(":") ? "IPv6" : "IPv4", internal, mac: "00:00:00:00:00:00", netmask: "" }) as unknown as Address;

/** Build a `networkInterfaces()` stub from a fixed interface map. */
const reader =
    (interfaces: Interfaces): (() => Interfaces) =>
    () =>
        interfaces;

describe(hasIpv6Loopback, () => {
    it("is true when a loopback interface carries `::1`", () => {
        expect.assertions(1);

        const result = hasIpv6Loopback(reader({ lo: [address("127.0.0.1", true), address("::1", true)] }));

        expect(result).toBe(true);
    });

    it("is false when only an IPv4 loopback exists (no `::1`)", () => {
        expect.assertions(1);

        expect(hasIpv6Loopback(reader({ lo: [address("127.0.0.1", true)] }))).toBe(false);
    });

    it("is false when `::1` is only present on a non-internal interface", () => {
        expect.assertions(1);

        // A routable IPv6 address is not the loopback — workerd's `[::1]` bind
        // would still fail, so this must not count as loopback support.
        expect(hasIpv6Loopback(reader({ eth0: [address("::1", false)] }))).toBe(false);
    });

    it("is false when there are no interfaces at all", () => {
        expect.assertions(1);

        expect(hasIpv6Loopback(reader({}))).toBe(false);
    });
});
