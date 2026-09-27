/* eslint-disable sonarjs/no-hardcoded-ip -- the address literals are the inputs under test */
import { describe, expect, it } from "vitest";

import { ipRateLimitKey } from "../../../shared/ip-rate-limit-key";

describe(ipRateLimitKey, () => {
    it.each([
        // Same /64, in compressed, expanded, upper-case and zone-id spellings.
        ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
        ["2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
        ["2001:DB8:1:2:A:B:C:D", "2001:db8:1:2::/64"],
        ["fe80::1%eth0", "fe80:0:0:0::/64"],
        ["2001:db8::", "2001:db8:0:0::/64"],
        ["::1", "0:0:0:0::/64"],
        // A different /64 stays distinct.
        ["2001:db8:1:3::1", "2001:db8:1:3::/64"],
        // IPv4-mapped IPv6 is the IPv4 client it wraps, dotted or hex.
        ["::ffff:203.0.113.7", "203.0.113.7"],
        ["::FFFF:cb00:7107", "203.0.113.7"],
        ["0:0:0:0:0:ffff:203.0.113.7", "203.0.113.7"],
    ])("collapses %s to %s", (input, expected) => {
        expect.assertions(1);

        expect(ipRateLimitKey(input)).toBe(expected);
    });

    it.each(["203.0.113.7", "user_123", "alice@example.com", "anon", "", "team:42", "2001:db8::g", "1:2:3:4:5:6:7:8:9"])("leaves %s unchanged", (input) => {
        expect.assertions(1);

        expect(ipRateLimitKey(input)).toBe(input);
    });
});
