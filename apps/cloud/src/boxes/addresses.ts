/**
 * The addresses a box may enrol with (plan 458 G12/G13).
 *
 * A box's IPs become A/AAAA records in the platform's own zone
 * (`*.{slug}.{LUNORA_BOX_DOMAIN}`). An address that is not publicly routable
 * would turn a Lunora hostname into a pointer at somebody's loopback or LAN —
 * a DNS-rebinding foothold under our name — so only global unicast addresses
 * are accepted. A box behind NAT with no public address is out of scope for v1
 * (plan 458 §9 Q8).
 */

const IPV6_CHARACTERS = /^[\d:a-f]+$/iu;

const IPV6_GROUP = /^[\da-f]{1,4}$/iu;

const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;

/** `[first, second-octet range]` blocks that are not publicly routable (RFC 6890 and friends). */
const PRIVATE_IPV4: ReadonlyArray<{ first: number; secondFrom?: number; secondTo?: number }> = [
    { first: 0 },
    { first: 10 },
    // CGNAT, 100.64.0.0/10.
    { first: 100, secondFrom: 64, secondTo: 127 },
    { first: 127 },
    // Link-local, which includes the cloud metadata address 169.254.169.254.
    { first: 169, secondFrom: 254, secondTo: 254 },
    { first: 172, secondFrom: 16, secondTo: 31 },
    { first: 192, secondFrom: 168, secondTo: 168 },
    // Benchmarking, 198.18.0.0/15.
    { first: 198, secondFrom: 18, secondTo: 19 },
];

/** Whether `value` is a dotted-quad IPv4 address a box may publish. */
export const isPublicIpv4 = (value: string): boolean => {
    if (!IPV4_PATTERN.test(value)) {
        return false;
    }

    const [first = 0, second = 0] = value.split(".").map(Number);

    // Multicast and the reserved 240/4, plus broadcast.
    if (first >= 224) {
        return false;
    }

    return !PRIVATE_IPV4.some(
        (block) => block.first === first && (block.secondFrom === undefined || (second >= block.secondFrom && second <= (block.secondTo ?? 255))),
    );
};

/** Expand an IPv6 address into its eight 16-bit groups, or `null` when it is not one. Embedded IPv4 tails are refused. */
const ipv6Groups = (value: string): null | number[] => {
    if (value.length > 39 || !IPV6_CHARACTERS.test(value)) {
        return null;
    }

    const halves = value.split("::");

    if (halves.length > 2) {
        return null;
    }

    const parse = (part: string): null | number[] => {
        if (part === "") {
            return [];
        }

        const groups = part.split(":");

        return groups.every((group) => IPV6_GROUP.test(group)) ? groups.map((group) => Number.parseInt(group, 16)) : null;
    };

    const head = parse(halves[0] ?? "");
    const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];

    if (head === null || tail === null) {
        return null;
    }

    if (halves.length === 1) {
        return head.length === 8 ? head : null;
    }

    const missing = 8 - head.length - tail.length;

    return missing >= 1 ? [...head, ...Array.from<number>({ length: missing }).fill(0), ...tail] : null;
};

/** Whether `value` is a global-unicast IPv6 address (2000::/3) a box may publish. */
export const isPublicIpv6 = (value: string): boolean => {
    const groups = ipv6Groups(value);

    if (groups === null) {
        return false;
    }

    const [first = 0] = groups;

    // 2000::/3 is the whole of global unicast; everything else — loopback, ULA
    // (fc00::/7), link-local (fe80::/10), multicast, mapped IPv4 — is not.
    // Documentation space (2001:db8::/32) is global-unicast-shaped but never routed.
    return first >= 0x20_00 && first <= 0x3f_ff && !(first === 0x20_01 && groups[1] === 0x0d_b8);
};
