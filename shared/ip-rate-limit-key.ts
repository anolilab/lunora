/**
 * Collapse an IP-address rate-limit key to the unit one client actually
 * controls. Shared by `@lunora/runtime`'s REST limiter and `@lunora/ratelimit`'s
 * `RateLimiter` (bundler-inlined, no dependency edge between them).
 *
 * An IPv6 end site is routinely delegated a whole /64 (often far more), so a
 * limit keyed on the full address hands one client 2^64 fresh buckets: rotate
 * the interface id per request and the limit never binds. An IPv6 literal is
 * therefore reduced to its /64 prefix (`2001:db8:1:2::/64`). An IPv4-mapped
 * address (`::ffff:192.0.2.1`) is the IPv4 client it wraps and becomes that
 * dotted address; a zone id (`fe80::1%eth0`) is dropped. Anything that is not
 * an IPv6 literal — IPv4, a user id, an email — is returned unchanged.
 *
 * Parsing is delegated to the WHATWG `URL` host parser, which validates the
 * literal and serialises it to one canonical, lower-case, hex-only form.
 */
export const ipRateLimitKey = (key: string): string => {
    const percent = key.indexOf("%");
    const address = percent === -1 ? key : key.slice(0, percent);

    if (!address.includes(":")) {
        return key;
    }

    let host: string;

    try {
        host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
        return key;
    }

    const [head = "", tail] = host.split("::");
    const left = head === "" ? [] : head.split(":");
    const right = tail === undefined || tail === "" ? [] : tail.split(":");
    const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right].map((group) => Number.parseInt(group, 16));

    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xff_ff) {
        const [high = 0, low = 0] = groups.slice(6);

        // eslint-disable-next-line no-bitwise -- splitting two 16-bit groups into four octets
        return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    }

    return `${groups
        .slice(0, 4)
        .map((group) => group.toString(16))
        .join(":")}::/64`;
};
