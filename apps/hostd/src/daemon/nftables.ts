/**
 * The fleets' egress policy (plan 458 W8, after Noite's tenant sandbox): one
 * nftables table, `inet lunora_hostd`, that `lunora-hostd` installs at start
 * (it holds `CAP_NET_ADMIN` from the systemd unit; no fleet does).
 *
 * Its one chain hooks `output` and looks only at sockets owned by the fleet
 * uid; every other process on the box is untouched. For the fleet uid it
 * accepts replies on connections already established (Caddy → fleet), DNS,
 * and the bucket endpoint's resolved addresses on its port — refreshed every
 * 30 s, because a bucket's addresses change — and then rejects loopback,
 * RFC 1918, link-local (with the `169.254.169.254` metadata service), CGNAT
 * `100.64.0.0/10`, `0.0.0.0/8`, and IPv6 loopback, unspecified, ULA,
 * link-local and v4-mapped. Everything else — the public internet an app
 * calls — is accepted.
 *
 * That blocks a fleet from the celld operator API (every fleet's internal
 * listener is on loopback, siblings' included), from hostd's on-demand-TLS
 * `ask` endpoint and Caddy's admin API (both loopback), from anything else
 * the box serves on loopback or a private network, and from the cloud
 * metadata service.
 *
 * The table is replaced atomically (`table`; `delete table`; the new table, in
 * one `nft -f` transaction) and left in place when hostd stops: no fleet runs
 * without hostd, and a stale table only ever blocks.
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";

import type { BucketConfig } from "./config";
import { CHILD_PATH } from "./fleet-environment";
import type { Logger } from "./log";

/** The table's family and name. */
const NFT_TABLE = "lunora_hostd";

/** How often the bucket endpoint is resolved again. */
const BUCKET_REFRESH_MS = 30_000;

/* eslint-disable sonarjs/no-hardcoded-ip -- the ranges a fleet is blocked FROM, not addresses anything connects to */

/** IPv4 ranges a fleet may not reach. */
const BLOCKED_IPV4 = [
    "0.0.0.0/8", // "this network": connecting to 0.0.0.0 reaches loopback listeners
    "10.0.0.0/8",
    "100.64.0.0/10", // CGNAT
    "127.0.0.0/8",
    "169.254.0.0/16", // link-local, with the 169.254.169.254 metadata service
    "172.16.0.0/12",
    "192.168.0.0/16",
] as const;

/** IPv6 ranges a fleet may not reach. */
const BLOCKED_IPV6 = [
    "::/128",
    "::1/128",
    "::ffff:0:0/96", // v4-mapped: the IPv4 rules see the packet, but say it twice
    "fc00::/7", // ULA
    "fe80::/10", // link-local
] as const;

/* eslint-enable sonarjs/no-hardcoded-ip */

/** Where Debian, Ubuntu (and Arch) install `nft`; an absolute path, never a `PATH` lookup. */
const NFT_CANDIDATES = ["/usr/sbin/nft", "/sbin/nft", "/usr/bin/nft"] as const;

/** The bucket endpoint's addresses, and the port a fleet reaches it on. */
interface BucketAddresses {
    ipv4: string[];
    ipv6: string[];
    port: number;
}

/** The host and port of the bucket endpoint: the configured one, or AWS S3's regional endpoint. */
const bucketEndpointOf = (bucket: BucketConfig): { host: string; port: number } => {
    const url = new URL(bucket.endpoint ?? `https://s3.${bucket.region ?? "us-east-1"}.amazonaws.com`);
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const defaultPort = url.protocol === "https:" ? 443 : 80;

    return { host, port: url.port === "" ? defaultPort : Number(url.port) };
};

const elementsOf = (addresses: ReadonlyArray<string>, port: number): string => addresses.map((address) => `${address} . ${String(port)}`).join(", ");

const setDefinition = (name: string, type: string, addresses: ReadonlyArray<string>, port: number): string[] => [
    `    set ${name} {`,
    `        type ${type} . inet_service`,
    ...(addresses.length === 0 ? [] : [`        elements = { ${elementsOf(addresses, port)} }`]),
    "    }",
];

/** Only literal addresses ever reach the ruleset text. */
const checked = (bucket: BucketAddresses): BucketAddresses => {
    return { ipv4: bucket.ipv4.filter((address) => isIPv4(address)), ipv6: bucket.ipv6.filter((address) => isIPv6(address)), port: bucket.port };
};

/**
 * The whole table, as an `nft -f` script that replaces any previous one in a
 * single transaction.
 */
const nftRuleset = (fleetUid: number, bucket: BucketAddresses): string => {
    const { ipv4, ipv6, port } = checked(bucket);

    return [
        `table inet ${NFT_TABLE}`,
        `delete table inet ${NFT_TABLE}`,
        `table inet ${NFT_TABLE} {`,
        ...setDefinition("bucket_v4", "ipv4_addr", ipv4, port),
        ...setDefinition("bucket_v6", "ipv6_addr", ipv6, port),
        "    chain fleet_egress {",
        "        type filter hook output priority 0; policy accept;",
        `        meta skuid != ${String(fleetUid)} return`,
        "        ct state established,related accept",
        "        udp dport 53 accept",
        "        tcp dport 53 accept",
        "        ip daddr . tcp dport @bucket_v4 accept",
        "        ip6 daddr . tcp dport @bucket_v6 accept",
        `        ip daddr { ${BLOCKED_IPV4.join(", ")} } reject`,
        `        ip6 daddr { ${BLOCKED_IPV6.join(", ")} } reject`,
        "    }",
        "}",
        "",
    ].join("\n");
};

/** An `nft -f` script that swaps the bucket sets' elements in one transaction. */
const nftBucketUpdate = (bucket: BucketAddresses): string => {
    const { ipv4, ipv6, port } = checked(bucket);

    return [
        `flush set inet ${NFT_TABLE} bucket_v4`,
        `flush set inet ${NFT_TABLE} bucket_v6`,
        ...(ipv4.length === 0 ? [] : [`add element inet ${NFT_TABLE} bucket_v4 { ${elementsOf(ipv4, port)} }`]),
        ...(ipv6.length === 0 ? [] : [`add element inet ${NFT_TABLE} bucket_v6 { ${elementsOf(ipv6, port)} }`]),
        "",
    ].join("\n");
};

/** Run `nft` with `args`, feeding it `script` on stdin. Rejects with what nft printed when it fails. */
const runNft = async (args: ReadonlyArray<string>, script = ""): Promise<string> =>
    new Promise((resolve, reject) => {
        const nft = NFT_CANDIDATES.find((path) => existsSync(path));

        if (nft === undefined) {
            reject(new Error(`nft is not installed (looked in ${NFT_CANDIDATES.join(", ")})`));

            return;
        }

        const child = spawn(nft, args, { env: { PATH: CHILD_PATH }, stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, 10_000);

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`could not run nft: ${error.message}`));
        });
        child.once("exit", (code) => {
            clearTimeout(timer);

            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`nft ${args.join(" ")} exited ${String(code)}: ${output.trim().slice(0, 500)}`));
            }
        });
        child.stdin.end(script);
    });

/** What the firewall needs from the system; the real one runs `nft` and resolves with the system resolver. */
interface FirewallSystem {
    /** Apply an `nft -f` script. */
    apply: (script: string) => Promise<void>;
    /** Whether the table is loaded. */
    present: () => Promise<boolean>;
    resolve: (host: string) => Promise<{ ipv4: string[]; ipv6: string[] }>;
}

const REAL_FIREWALL_SYSTEM: FirewallSystem = {
    apply: async (script) => {
        await runNft(["-f", "-"], script);
    },
    present: async () =>
        runNft(["list", "table", "inet", NFT_TABLE]).then(
            () => true,
            () => false,
        ),
    resolve: async (host) => {
        if (isIPv4(host)) {
            return { ipv4: [host], ipv6: [] };
        }

        if (isIPv6(host)) {
            return { ipv4: [], ipv6: [host] };
        }

        const addresses = await lookup(host, { all: true });

        return {
            ipv4: addresses.filter((entry) => entry.family === 4).map((entry) => entry.address),
            ipv6: addresses.filter((entry) => entry.family === 6).map((entry) => entry.address),
        };
    },
};

interface EgressFirewallOptions {
    bucket: BucketConfig;
    fleetUid: number;
    logger: Logger;
    refreshMs?: number;
    system?: FirewallSystem;
}

const sameAddresses = (a: BucketAddresses, b: BucketAddresses): boolean =>
    a.port === b.port && a.ipv4.join(",") === b.ipv4.join(",") && a.ipv6.join(",") === b.ipv6.join(",");

/** The egress table: installed once, its bucket sets kept current. */
class EgressFirewall {
    private current: BucketAddresses = { ipv4: [], ipv6: [], port: 0 };

    private timer: ReturnType<typeof setInterval> | undefined;

    private readonly options: EgressFirewallOptions;

    private readonly system: FirewallSystem;

    public constructor(options: EgressFirewallOptions) {
        this.options = options;
        this.system = options.system ?? REAL_FIREWALL_SYSTEM;
    }

    /**
     * Install the table and check that it is loaded, then refresh the bucket's
     * addresses every 30 s.
     * @throws {Error} when nft refuses the table or it is not there afterwards.
     */
    public async install(): Promise<void> {
        const endpoint = bucketEndpointOf(this.options.bucket);

        this.current = { ...(await this.resolveQuietly(endpoint.host)), port: endpoint.port };
        await this.system.apply(nftRuleset(this.options.fleetUid, this.current));

        if (!(await this.system.present())) {
            throw new Error(`the nftables table inet ${NFT_TABLE} is not loaded after applying it`);
        }

        this.timer = setInterval(() => {
            this.refresh().catch((error: unknown) => {
                this.options.logger.warn(`could not refresh the bucket's addresses in the egress table: ${(error as Error).message}`);
            });
        }, this.options.refreshMs ?? BUCKET_REFRESH_MS);
        this.timer.unref();
    }

    /** Resolve the bucket endpoint again and swap the sets when its addresses changed. */
    public async refresh(): Promise<void> {
        const endpoint = bucketEndpointOf(this.options.bucket);
        const next = { ...(await this.system.resolve(endpoint.host)), port: endpoint.port };

        next.ipv4.sort((a, b) => a.localeCompare(b));
        next.ipv6.sort((a, b) => a.localeCompare(b));

        if (sameAddresses(next, this.current)) {
            return;
        }

        await this.system.apply(nftBucketUpdate(next));
        this.current = next;
    }

    /** Stop refreshing. The table stays: a stale one only blocks. */
    public stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** The first resolution may fail (DNS not up yet): start with empty sets, the refresh fills them. */
    private async resolveQuietly(host: string): Promise<{ ipv4: string[]; ipv6: string[] }> {
        try {
            const resolved = await this.system.resolve(host);

            return { ipv4: resolved.ipv4.toSorted((a, b) => a.localeCompare(b)), ipv6: resolved.ipv6.toSorted((a, b) => a.localeCompare(b)) };
        } catch (error) {
            this.options.logger.warn(`could not resolve the bucket endpoint ${host}: ${(error as Error).message}; retrying every 30 s`);

            return { ipv4: [], ipv6: [] };
        }
    }
}

export type { BucketAddresses, EgressFirewallOptions, FirewallSystem };
export { BLOCKED_IPV4, BLOCKED_IPV6, BUCKET_REFRESH_MS, bucketEndpointOf, EgressFirewall, NFT_TABLE, nftBucketUpdate, nftRuleset, runNft };
