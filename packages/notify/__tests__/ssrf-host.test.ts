import { describe, expect, it } from "vitest";

import { isPrivateHost } from "../../../shared/ssrf-host";

/**
 * The shared SSRF host classifier, table-driven over `new URL(x).hostname` — the
 * exact input every caller hands it, AFTER the WHATWG parser has normalised the
 * literal (so `[::ffff:0:169.254.169.254]` arrives as `[::ffff:0:a9fe:a9fe]`).
 */
const hostOf = (url: string): string => new URL(url).hostname;

describe("isPrivateHost", () => {
    it.each([
        // IPv4 special-purpose ranges (RFC 6890).
        ["https://0.0.0.0/", "this host"],
        ["https://10.1.2.3/", "private 10/8"],
        ["https://100.64.0.1/", "CGNAT"],
        ["https://127.0.0.1/", "loopback"],
        ["https://169.254.169.254/", "link-local metadata"],
        ["https://172.16.0.1/", "private 172.16/12"],
        ["https://192.0.0.8/", "IETF protocol assignments 192.0.0/24"],
        ["https://192.0.2.1/", "TEST-NET-1"],
        ["https://192.88.99.1/", "6to4 relay anycast"],
        ["https://192.168.1.1/", "private 192.168/16"],
        ["https://198.18.0.1/", "benchmarking 198.18/15"],
        ["https://198.19.255.254/", "benchmarking 198.18/15, upper half"],
        ["https://198.51.100.7/", "TEST-NET-2"],
        ["https://203.0.113.9/", "TEST-NET-3"],
        ["https://224.0.0.1/", "multicast"],
        ["https://255.255.255.255/", "broadcast"],
        // IPv6.
        ["https://[::]/", "unspecified"],
        ["https://[::1]/", "loopback"],
        ["https://[fe80::1]/", "link-local"],
        ["https://[fc00::1]/", "unique-local"],
        ["https://[fec0::1]/", "deprecated site-local fec0::/10"],
        ["https://[feff::1]/", "deprecated site-local fec0::/10, upper end"],
        ["https://[ff02::1]/", "multicast ff00::/8"],
        ["https://[2001:db8::1]/", "documentation 2001:db8::/32"],
        ["https://[100::1]/", "discard-only 100::/64"],
        // Embedded IPv4, every translation form.
        ["https://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
        ["https://[::ffff:0:a9fe:a9fe]/", "SIIT IPv4-translated ::ffff:0:0:0/96 metadata"],
        ["https://[::ffff:0:169.254.169.254]/", "SIIT, dotted as written"],
        ["https://[::ffff:0:0:1]/", "SIIT embedding 0.0.0.1"],
        ["https://[::127.0.0.1]/", "IPv4-compatible loopback"],
        ["https://[::0.0.169.254]/", "IPv4-compatible, single-group form"],
        ["https://[64:ff9b::a9fe:a9fe]/", "NAT64 well-known prefix"],
        ["https://[64:ff9b:1::a9fe:a9fe]/", "NAT64 local-use prefix 64:ff9b:1::/48"],
        ["https://[64:ff9b:1:a9fe:a9:fe00::]/", "NAT64 local-use, RFC 6052 /48 layout"],
        ["https://[2002:a9fe:a9fe::]/", "6to4"],
        ["https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "Teredo"],
        // Names.
        ["https://localhost./", "localhost FQDN"],
        ["https://redis.internal/", "internal namespace"],
    ])("classifies %s as private (%s)", (url) => {
        expect.assertions(1);

        expect(isPrivateHost(hostOf(url))).toBe(true);
    });

    it.each([
        ["https://8.8.8.8/", "public IPv4"],
        ["https://1.1.1.1/", "public IPv4"],
        ["https://192.0.1.1/", "just above 192.0.0/24"],
        ["https://198.17.255.255/", "just below 198.18/15"],
        ["https://198.20.0.1/", "just above 198.18/15"],
        ["https://203.0.114.1/", "just above TEST-NET-3"],
        ["https://[2606:4700:4700::1111]/", "public IPv6"],
        ["https://[2001:4860:4860::8888]/", "public IPv6 in 2001::/16 but not Teredo or documentation"],
        ["https://[::ffff:8.8.8.8]/", "IPv4-mapped public"],
        ["https://[::ffff:0:808:808]/", "SIIT embedding a public IPv4"],
        ["https://[fe00::1]/", "below fe80::/10"],
        ["https://example.com/", "public name"],
    ])("classifies %s as public (%s)", (url) => {
        expect.assertions(1);

        expect(isPrivateHost(hostOf(url))).toBe(false);
    });
});
