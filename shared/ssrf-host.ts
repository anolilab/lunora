/**
 * `shared/ssrf-host.ts` — a zero-dependency, bundler-inlined SSRF host classifier.
 *
 * Decides whether a URL's `hostname` names a loopback / private / link-local /
 * CGNAT / reserved target — the addresses an SSRF guard must refuse before a
 * worker is allowed to `fetch` it. Purely a string classifier: it inspects the
 * host AS-WRITTEN and does NOT resolve DNS, so a public name that resolves (via
 * attacker-controlled DNS) to a private IP is out of scope here (classic DNS
 * rebinding — close it with an exact-origin allowlist at the call site).
 *
 * The IPv4/IPv6 range tables and the WHATWG-normalised-literal handling are
 * lifted verbatim from `@lunora/browser`'s exemplary, heavily-tested SSRF guard
 * (`packages/browser/src/create-browser.ts`) so callers reuse proven logic
 * rather than hand-rolling a (subtly wrong, esp. for IPv6) private-range matcher.
 * Returns booleans only — no `LunoraError`, no imports — so it stays inline-safe
 * per the repo `shared/` convention; the caller wraps a positive result in its
 * own user-facing error.
 */

/** Canonical dotted-quad octet matcher (1–3 digits), hoisted so it isn't recompiled per host part. */
const IPV4_OCTET = /^\d{1,3}$/u;

/** IPv4-mapped IPv6 in the hex form the WHATWG `URL` parser emits (`::ffff:7f00:1`). */
const IPV6_MAPPED_HEX = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u;

/**
 * SIIT IPv4-translated IPv6, `::ffff:0:0:0/96` (RFC 6052 §2.1 / RFC 7915), in the
 * form the WHATWG parser emits (`::ffff:0:a9fe:a9fe`). A translator forwards to
 * the embedded IPv4, so it is classified like the mapped form.
 */
const IPV6_TRANSLATED_HEX = /^::ffff:0:([\da-f]{1,4}):([\da-f]{1,4})$/u;

/**
 * IPv4-compatible with a zero high word (`::0.0.169.254` → `::a9fe`). The embedded
 * address is `0.0.x.x`, inside `0.0.0.0/8`, so every such host is private.
 */
const IPV6_COMPATIBLE_LOW_ONLY = /^::[\da-f]{1,4}$/u;

/** IPv4-mapped IPv6 in dotted form (`::ffff:127.0.0.1`), for parsers that keep it. */
const IPV6_MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u;

/**
 * IPv4-compatible IPv6 (`::a.b.c.d` dotted form; deprecated but still parsed).
 * The WHATWG URL parser normalizes these to a non-`ffff` two-word hex form such
 * as `::7f00:1` for `::127.0.0.1`. We match both shapes.
 */
const IPV6_COMPATIBLE_DOTTED = /^::(\d{1,3}(?:\.\d{1,3}){3})$/u;

/**
 * IPv4-compatible in the compact two-word hex form the WHATWG parser emits
 * (`::W:X` where the full 128-bit prefix is `0000…0000:W:X`). Distinguishable
 * from `::ffff:W:X` (mapped) because the `ffff` group is absent.
 */
const IPV6_COMPATIBLE_HEX = /^::([\da-f]{1,4}):([\da-f]{1,4})$/u;

/**
 * NAT64 well-known prefix `64:ff9b::/96`. The WHATWG URL parser expands the
 * embedded IPv4 into a full eight-group address, so we match the normalised
 * `64:ff9b::W:X` compact form (two trailing hex words encoding the IPv4).
 */
const IPV6_NAT64_HEX = /^64:ff9b::[\da-f]{1,4}:[\da-f]{1,4}$/u;

/** One IPv6 hex group (1–4 digits). */
const IPV6_GROUP = /^[\da-f]{1,4}$/u;

/** An IPv6 prefix as `[leading groups, prefix length in bits]`; groups past the ones listed are zero. */
type Ipv6Prefix = readonly [readonly number[], number];

/**
 * IANA IPv6 special-purpose registry blocks marked NOT globally reachable that
 * need more than a string-prefix test (a sub-group boundary or a `::`-compressed
 * form). `2001::/23` (IETF protocol assignments) takes in Teredo `2001::/32`,
 * benchmarking `2001:2::/48` and the deprecated ORCHID `2001:10::/28`; its
 * globally reachable carve-outs are listed in {@link GLOBAL_IPV6_CARVE_OUTS}.
 * Teredo is blocked for its embedded IPv4, like 6to4 and NAT64 below.
 */
const NON_GLOBAL_IPV6: ReadonlyArray<Ipv6Prefix> = [
    [[0x20_01], 23], // 2001::/23 IETF protocol assignments
    [[0x3f_ff], 20], // 3fff::/20 documentation (RFC 9637)
    [[0x5f_00], 16], // 5f00::/16 SRv6 SIDs (RFC 9602)
    [[0x1_00, 0, 0, 1], 64], // 100:0:0:1::/64 dummy prefix (RFC 9780)
];

/** The globally reachable assignments inside `2001::/23`, per the same registry. */
const GLOBAL_IPV6_CARVE_OUTS: ReadonlyArray<Ipv6Prefix> = [
    [[0x20_01, 1, 0, 0, 0, 0, 0, 1], 128], // PCP anycast
    [[0x20_01, 1, 0, 0, 0, 0, 0, 2], 128], // TURN anycast
    [[0x20_01, 1, 0, 0, 0, 0, 0, 3], 128], // DNS-SD SRP anycast
    [[0x20_01, 3], 32], // AMT
    [[0x20_01, 4, 0x1_12], 48], // AS112-v6
    [[0x20_01, 5], 32], // LISP EID space
    [[0x20_01, 0x20], 28], // ORCHIDv2
    [[0x20_01, 0x30], 28], // drone remote ID (DETs)
];

/** Expand an IPv6 literal (hex groups, at most one `::`) to its eight 16-bit groups, or `undefined`. */
const expandIpv6 = (ip: string): number[] | undefined => {
    const halves = ip.split("::");

    if (halves.length > 2) {
        return undefined;
    }

    const parse = (part: string | undefined): number[] =>
        part === undefined || part === "" ? [] : part.split(":").map((group) => (IPV6_GROUP.test(group) ? Number.parseInt(group, 16) : Number.NaN));
    const head = parse(halves[0]);
    const tail = parse(halves[1]);
    const zeros = 8 - head.length - tail.length;

    if (zeros < 0 || (halves.length === 1 && zeros !== 0)) {
        return undefined;
    }

    const groups = [...head, ...Array.from({ length: zeros }, () => 0), ...tail];

    return groups.some(Number.isNaN) ? undefined : groups;
};

/** Whether eight expanded `groups` fall inside `prefix`. */
const inIpv6Prefix = (groups: readonly number[], [prefix, length]: Ipv6Prefix): boolean => {
    for (let index = 0; index * 16 < length; index += 1) {
        const bits = Math.min(16, length - index * 16);
        // eslint-disable-next-line no-bitwise -- masking a 16-bit group to the prefix's bits
        const mask = (0xff_ff << (16 - bits)) & 0xff_ff;

        // eslint-disable-next-line no-bitwise -- see above
        if (((groups[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) {
            return false;
        }
    }

    return true;
};

/** Leading / trailing `URL.hostname` IPv6 brackets (`[::1]`). */
const IPV6_BRACKETS = /^\[|\]$/gu;

/** A single trailing FQDN dot on a `URL.hostname` (`localhost.` → `localhost`). */
const TRAILING_DOT = /\.$/u;

/**
 * Parse a canonical dotted-quad IPv4 string into its four octets, or `undefined`
 * if it isn't one. The WHATWG `URL` parser already normalizes the octal/hex/integer
 * IPv4 forms (`0177.0.0.1`, `0x7f.1`, `2130706433`) to dotted-decimal, so by the
 * time a hostname reaches here an IPv4 literal is always canonical — closing those
 * SSRF-bypass encodings for free.
 */
const parseIpv4 = (host: string): [number, number, number, number] | undefined => {
    const parts = host.split(".");

    if (parts.length !== 4) {
        return undefined;
    }

    const octets = parts.map((part) => (IPV4_OCTET.test(part) ? Number(part) : -1));

    if (octets.some((octet) => octet < 0 || octet > 255)) {
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- octets.length === 4 guaranteed by the parts.length === 4 check above
    return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
};

/**
 * True if an IPv4 octet tuple is in a special-purpose range (RFC 6890) — loopback,
 * private, link-local, CGNAT, protocol-assignment, benchmarking, documentation,
 * multicast or reserved. None of them is a public destination, and the
 * benchmarking and protocol-assignment blocks are routinely routed internally.
 * `192.0.0.0/24` is blocked whole, including its two globally reachable anycast
 * service addresses (`192.0.0.9`, `192.0.0.10`), which no app has reason to fetch.
 */
const isPrivateIpv4 = ([a, b, c]: [number, number, number, number]): boolean =>
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 protocol assignments, 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay anycast
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast

/**
 * Decode the embedded 32-bit IPv4 from two hex groups (high word, low word)
 * and test it against the private-range table. Returns `true` when the decoded
 * address is private, or when the groups cannot be parsed (fail-closed).
 */
const isPrivateEmbeddedIpv4 = (highGroup: string | undefined, lowGroup: string | undefined): boolean => {
    const high = Number.parseInt(highGroup ?? "", 16);
    const low = Number.parseInt(lowGroup ?? "", 16);

    // If either group doesn't parse cleanly, treat as private (fail-closed).
    if (!Number.isFinite(high) || !Number.isFinite(low)) {
        return true;
    }

    return isPrivateIpv4([Math.floor(high / 256), high % 256, Math.floor(low / 256), low % 256]);
};

/** True if an IPv6 literal (brackets already stripped) is loopback / unspecified / ULA / link-local, or maps to a private IPv4. */
const isPrivateIpv6 = (host: string): boolean => {
    const ip = host.toLowerCase();

    // IPv4-mapped (`::ffff:127.0.0.1`). The WHATWG `URL` parser normalizes the
    // embedded IPv4 to two hex words (`::ffff:7f00:1`); accept the dotted form too
    // for parsers that keep it. Either way, decode the low 32 bits and reuse the
    // IPv4 ranges so a mapped loopback/private address can't slip past.
    const mappedHex = IPV6_MAPPED_HEX.exec(ip);

    if (mappedHex) {
        return isPrivateEmbeddedIpv4(mappedHex[1], mappedHex[2]);
    }

    const translated = IPV6_TRANSLATED_HEX.exec(ip);

    if (translated) {
        return isPrivateEmbeddedIpv4(translated[1], translated[2]);
    }

    const mappedDotted = IPV6_MAPPED_DOTTED.exec(ip);

    if (mappedDotted) {
        const v4 = parseIpv4(mappedDotted[1] ?? "");

        return v4 === undefined || isPrivateIpv4(v4);
    }

    // IPv4-compatible (`::a.b.c.d` dotted; deprecated).
    const compatDotted = IPV6_COMPATIBLE_DOTTED.exec(ip);

    if (compatDotted) {
        const v4 = parseIpv4(compatDotted[1] ?? "");

        return v4 === undefined || isPrivateIpv4(v4);
    }

    // IPv4-compatible in the WHATWG-normalised hex form (`::W:X`, no `ffff`).
    const compatHex = IPV6_COMPATIBLE_HEX.exec(ip);

    if (compatHex) {
        return isPrivateEmbeddedIpv4(compatHex[1], compatHex[2]);
    }

    if (IPV6_COMPATIBLE_LOW_ONLY.test(ip)) {
        return true;
    }

    // NAT64 well-known prefix `64:ff9b::/96`. Block unconditionally: any address
    // in this range translates an embedded IPv4 at the egress NAT64 gateway, and
    // an embedded private IPv4 (e.g. 169.254.169.254) reaches an internal host.
    if (IPV6_NAT64_HEX.test(ip)) {
        return true;
    }

    // NAT64 local-use prefix `64:ff9b:1::/48` (RFC 8215) — the operator's own
    // translator, so the same reasoning applies. Blocked whole rather than by
    // decoding the IPv4: under a /48 prefix RFC 6052 splits the embedded address
    // around the reserved `u` octet (bits 48–63 and 72–87), and an operator may
    // carve longer prefixes out of it with other layouts, so no single decode is
    // right for every address in the block.
    if (ip.startsWith("64:ff9b:1:")) {
        return true;
    }

    // 6to4 (`2002::/16`) embeds a 32-bit IPv4 in the two groups after the prefix
    // (`2002:7f00:1::` carries `127.0.0.1`). A 6to4 relay forwards to that embedded
    // IPv4, so an embedded private/link-local address reaches an internal host —
    // block the whole prefix, mirroring the NAT64 posture above.
    if (ip.startsWith("2002:")) {
        return true;
    }

    // Matched on expanded groups, not as-written text: a block boundary can fall
    // inside a group, and `::` compression hides zero groups (Teredo
    // `2001:0:0:0:0:0:a9fe:a9fe` is written `2001::a9fe:a9fe`).
    const groups = expandIpv6(ip);

    if (
        groups !== undefined &&
        NON_GLOBAL_IPV6.some((prefix) => inIpv6Prefix(groups, prefix)) &&
        !GLOBAL_IPV6_CARVE_OUTS.some((prefix) => inIpv6Prefix(groups, prefix))
    ) {
        return true;
    }

    return (
        ip === "::" || // unspecified
        ip === "::1" || // loopback
        ip.startsWith("fc") || // fc00::/7 unique-local
        ip.startsWith("fd") || // fc00::/7 unique-local
        ip.startsWith("fe8") || // fe80::/10 link-local
        ip.startsWith("fe9") ||
        ip.startsWith("fea") ||
        ip.startsWith("feb") ||
        ip.startsWith("fec") || // fec0::/10 site-local (deprecated, still routed on some internal networks)
        ip.startsWith("fed") ||
        ip.startsWith("fee") ||
        ip.startsWith("fef") ||
        ip.startsWith("ff") || // ff00::/8 multicast (the IPv4 side blocks 224.0.0.0/4 too)
        ip.startsWith("2001:db8:") || // 2001:db8::/32 documentation
        // 100::/64 discard-only. WHATWG compression always renders its three zero
        // groups as `100::`; the prefix also takes in a few other `100::/8`
        // addresses, all IETF-reserved and none a public destination.
        ip.startsWith("100::")
    );
};

/** Special-use hostname literals that resolve to the local host / internal namespaces. */
const isPrivateHostname = (host: string): boolean =>
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa");

/** Normalize a `URL.hostname` for comparison: strip IPv6 brackets + a trailing FQDN dot, lowercase. */
const normalizeHost = (host: string): string => host.replaceAll(IPV6_BRACKETS, "").replace(TRAILING_DOT, "").toLowerCase();

/**
 * Classify a `URL.hostname` as a private / internal SSRF target.
 *
 * IPv6 hosts arrive bracketed from `URL.hostname` (`[::1]`); a NAMED host keeps a
 * WHATWG-preserved trailing dot (`localhost.`, `redis.internal.`) that resolves to
 * the same host — both are normalised away before matching so the FQDN form can't
 * bypass the special-hostname denylist. IPv4 literals are canonicalised by the URL
 * parser (octal/hex/integer forms), so an as-written literal is always dotted-quad
 * by the time it reaches here.
 *
 * @param hostname a `new URL(x).hostname` value (NOT a full URL).
 */
const isPrivateHost = (hostname: string): boolean => {
    const host = normalizeHost(hostname);

    if (host.includes(":")) {
        return isPrivateIpv6(host);
    }

    const v4 = parseIpv4(host);

    return v4 === undefined ? isPrivateHostname(host) : isPrivateIpv4(v4);
};

export { isPrivateHost, isPrivateIpv4, isPrivateIpv6, normalizeHost, parseIpv4 };
